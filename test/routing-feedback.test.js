#!/usr/bin/env node
// Tests the routing feedback loop in lib/newtask.js (Pat, 2026-10-02): every confirmed
// routing is logged to ~/logs/newtask-routing.jsonl with what was proposed and what was
// launched, a cancel logs nothing there, and corrected lines are taught back to Haiku in
// routingPrompt. HOME is a temp dir, so the log is the temp one. Haiku is a fake `claude`
// that always proposes client:BB; VS Code, the launcher and Clef are stubbed.
//
// Run: node test/routing-feedback.test.js
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-rfb-'));
const clients = path.join(tmp, 'clients');
for (const c of ['BB', 'CC']) fs.mkdirSync(path.join(clients, c), { recursive: true });
fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
fs.mkdirSync(path.join(tmp, '.cache', 'claude-code-helper'), { recursive: true });
process.env.HOME = tmp;
delete process.env.ANTHROPIC_API_KEY;
const claude = path.join(tmp, 'claude');
fs.writeFileSync(claude, '#!/bin/sh\necho \'{"kind":"session","target":"client:BB","slug":"printer-offline"}\'\n', { mode: 0o755 });
const LOG = path.join(tmp, 'logs', 'newtask-routing.jsonl');

const settings = { claudeCommand: claude, clientsDir: clients, projectsDir: path.join(tmp, 'projects'), scratchDir: path.join(tmp, 'tasks'), apiKeyFile: path.join(tmp, 'none'), asanaCommand: '', clefShadow: false };
let pickId = 'client:CC';   // what the stubbed folder picker answers
const vscode = {
  QuickPickItemKind: { Separator: -1 },
  ProgressLocation: { Window: 10 },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) },
  window: {
    withProgress: (_o, fn) => fn(),
    showErrorMessage: (m) => { throw new Error('unexpected error: ' + m); },
    createQuickPick() {
      const qp = { items: [], selectedItems: [] };
      qp.onDidAccept = (h) => { qp.accept = h; };
      qp.onDidHide = (h) => { qp.hide = h; };
      qp.onDidChangeValue = () => {};
      qp.dispose = () => {};
      qp.show = () => setImmediate(() => {
        qp.selectedItems = qp.items.filter((i) => i.target && i.target.id === pickId);
        qp.accept(); qp.hide();
      });
      return qp;
    },
  },
};
const launches = [];
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return vscode;
  if (req === '/home/work/tools/jev/jev.js') return { ask: () => Promise.resolve(null), shadow: () => {} };
  if (req === './launch') return { tablessAvailable: () => false, startDtachMaster: async () => { throw new Error('unexpected'); }, launchClaude: async (fav, resume, opts) => { launches.push({ dir: fav.path, ...opts }); return true; } };
  return origLoad.apply(this, arguments);
};
const nt = require('../lib/newtask');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + JSON.stringify(detail)}`);
  if (!cond) failed++;
}
const readLog = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const run = (text, replies) => {
  const seen = [];
  const io = { state: () => {}, propose: async (p) => { seen.push(p); return replies.shift(); } };
  return nt.askClaudeSession(text, io).then(() => seen);
};
const line = (input, pt, ft, corrected = true, fk = 'session') => JSON.stringify({ ts: 'x', input, proposed: { kind: 'session', target: pt }, final: { kind: fk, target: ft }, corrected }) + '\n';

(async () => {
  // 1. Confirmed without a change: one line, corrected false.
  await run('printer at BB is offline', [{ type: 'confirm' }]);
  let l = readLog();
  check('plain confirm is logged, corrected false', l.length === 1 && l[0].corrected === false && l[0].input === 'printer at BB is offline'
    && l[0].proposed.target === 'client:BB' && l[0].final.target === 'client:BB' && l[0].final.kind === 'session' && l[0].ts, l);

  // 2. Kind changed with Tab.
  await run('note for BB', [{ type: 'confirm', kind: 'asana' }]);
  l = readLog();
  check('kind change is a correction', l.length === 2 && l[1].corrected === true && l[1].proposed.kind === 'session' && l[1].final.kind === 'asana', l[1]);

  // 3. Target rejected, another picked.
  await run('something for CC', [{ type: 'pickTarget' }, { type: 'confirm' }]);
  l = readLog();
  check('target change is a correction', l.length === 3 && l[2].corrected === true && l[2].proposed.target === 'client:BB' && l[2].final.target === 'client:CC', l[2]);
  check('the session launched in the corrected folder', launches[2] && launches[2].dir.includes(path.join('clients', 'CC')), launches);

  // 4. Cancel writes nothing.
  await run('never mind', [{ type: 'cancel' }]);
  check('cancel writes nothing', readLog().length === 3, readLog().length);

  // 5. A failing log write does not stop the launch.
  const before = launches.length;
  fs.rmSync(path.join(tmp, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'logs'), 'a file where the directory should be');
  await run('log is unwritable', [{ type: 'confirm' }]);
  check('unwritable log does not stop the launch', launches.length === before + 1, launches.length);
  fs.rmSync(path.join(tmp, 'logs'));

  // 6. Prompt feedback. Missing log: no section at all, prompt identical to one without.
  const targets = [{ id: 'client:BB', name: 'BB', desc: 'Bergmann' }, { id: 'client:CC', name: 'CC', desc: 'Conrad' }];
  const base = nt.routingPrompt('x', targets, null);
  check('missing log leaves the prompt unchanged', !/corrected these/.test(base));
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, 'not json\n{"half":\n\n' + '\x00\x01garbage\n');
  check('garbage log leaves the prompt unchanged', nt.routingPrompt('x', targets, null) === base);

  // 7. A correction appears after the Rules, in the specified form.
  fs.writeFileSync(LOG, line('router at CC', 'client:BB', 'client:CC'));
  let p = nt.routingPrompt('x', targets, null);
  check('prompt includes the correction after the Rules',
    p.includes('"router at CC" → kind session, target client:CC (you had proposed client:BB)')
    && p.indexOf('Pat corrected these earlier routings') > p.indexOf('- slug:'), p);
  fs.writeFileSync(LOG, line('x1', 'client:BB', 'client:BB', false));
  check('uncorrected lines are not taught', nt.routingPrompt('x', targets, null) === base);

  // 8. Dedupe by input: newest wins; and newest first.
  fs.writeFileSync(LOG, line('dup', 'client:BB', 'client:CC') + line('other', 'client:BB', 'client:CC') + line('dup', 'client:CC', 'client:BB', true, 'asana'));
  const fb = nt.routingFeedback(targets);
  check('dedupe keeps the newest, newest first', fb.length === 2 && fb[0].startsWith('"dup" → kind asana, target client:BB') && fb[1].startsWith('"other"'), fb);

  // 9. Vanished target dropped; none kept.
  fs.writeFileSync(LOG, line('gone', 'client:BB', 'client:ZZ') + line('nothing', 'client:BB', null));
  const fb2 = nt.routingFeedback(targets);
  check('vanished target dropped, none kept', fb2.length === 1 && fb2[0].startsWith('"nothing" → kind session, target none'), fb2);

  // 10. Cap 20, and only the log tail is read.
  fs.writeFileSync(LOG, Array.from({ length: 30 }, (_, i) => line('in' + i, 'client:BB', 'client:CC')).join(''));
  const fb3 = nt.routingFeedback(targets);
  check('capped at 20, newest first', fb3.length === 20 && fb3[0].startsWith('"in29"') && fb3[19].startsWith('"in10"'), fb3.length);
  const pad = line('padding', 'client:BB', 'client:BB', false).repeat(Math.ceil(300 * 1024 / 100));
  fs.writeFileSync(LOG, line('ancient', 'client:BB', 'client:CC') + pad + line('recent', 'client:BB', 'client:CC'));
  const fb4 = nt.routingFeedback(targets);
  check('only the last ~200 KB is read', fb4.length === 1 && fb4[0].startsWith('"recent"'), fb4);

  console.log(failed ? `\n${failed} FAILED` : '\nAll routing-feedback tests passed.');
  process.exit(failed ? 1 : 0);
})();
