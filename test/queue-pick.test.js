#!/usr/bin/env node
// Tests the queue checklist behind 📅 / ⏳ / 📥: the real pickFromQueue out of
// lib/newtask.js, a fake `asana` CLI printing a fixed queue, and a temp clients tree.
// VS Code and the terminal launch are stubbed; every launch is recorded instead.
//
// What it pins down: a ticked task opens in its client's folder (the one stamped with
// its gid when there is one), the rest-walk skips exactly the ticked gids, Enter on the
// untouched list is the old full walk, and Esc starts nothing.
//
// Run: node test/queue-pick.test.js
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-queue-'));
const clients = path.join(tmp, 'clients');
fs.mkdirSync(path.join(clients, 'RAH', 'old-work'), { recursive: true });
fs.writeFileSync(path.join(clients, 'RAH', 'old-work', 'TASK.md'), '# x\n\n- **Task GID:** 1218000000222\n');
fs.mkdirSync(path.join(clients, 'BB'), { recursive: true });

const queue = [
  { gid: '1218000000111', name: '✨ Printer offline again', due_on: '2026-09-29', projects: [{ gid: 'p-bb', name: 'BB EDV' }],
    custom_fields: [{ enum_value: { name: '⏳ Input needed' } }] },
  { gid: '1218000000222', name: 'Mailbox migration', projects: [{ gid: 'p-rah', name: 'RAH EDV' }], custom_fields: [] },
  { gid: '1218000000333', name: 'Something else', projects: [{ gid: 'p-bb', name: 'BB EDV' }], custom_fields: [] },
];
const cli = path.join(tmp, 'asana');
fs.writeFileSync(cli, `#!/bin/sh\n[ "$1" = queue ] && cat ${JSON.stringify(path.join(tmp, 'q.json'))}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(tmp, 'q.json'), JSON.stringify(queue));
fs.mkdirSync(path.join(tmp, '.cache', 'claude-code-helper'), { recursive: true });
process.env.HOME = tmp;
fs.mkdirSync(path.join(tmp, '.cache', 'claude-code-helper'), { recursive: true });

// ─── stubs ───────────────────────────────────────────────────────────────────
let answer = null;   // (items) => selected items | null for Esc
const settings = { asanaCommand: cli, clientsDir: clients, projectsDir: path.join(tmp, 'projects'), scratchDir: path.join(tmp, 'tasks') };
const vscode = {
  QuickPickItemKind: { Separator: -1 },
  ProgressLocation: { Window: 10 },
  workspace: { getConfiguration: () => ({ get: (k) => settings[k] }) },
  window: {
    withProgress: (_o, fn) => fn(),
    showWarningMessage: (m) => { throw new Error('unexpected warning: ' + m); },
    showErrorMessage: (m) => { throw new Error('unexpected error: ' + m); },
    createQuickPick() {
      const qp = { items: [], selectedItems: [], accept: null, hide: null };
      qp.onDidAccept = (h) => { qp.accept = h; };
      qp.onDidHide = (h) => { qp.hide = h; };
      qp.onDidChangeValue = () => {};
      qp.dispose = () => {};
      qp.show = () => setImmediate(() => {
        const pick = answer(qp.items, qp.selectedItems);
        if (pick) { qp.selectedItems = pick; qp.accept(); }
        qp.hide();
      });
      return qp;
    },
  },
};
const launches = [];
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscode;
  if (req === './launch') return { launchClaude: async (fav, resume, opts) => { launches.push({ dir: fav.path, label: fav.label, resume, ...opts }); return {}; } };
  return origLoad.apply(this, arguments);
};
const asana = require('../lib/asana');
const nt = require('../lib/newtask');
// The project list the routing table is built from, as the cache would hold it.
fs.writeFileSync(asana.asanaCacheFile(), JSON.stringify([{ gid: 'p-bb', name: 'BB EDV' }, { gid: 'p-rah', name: 'RAH EDV' }]));

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + JSON.stringify(detail)}`);
  if (!cond) failed++;
}

(async () => {
  const projects = asana.loadAsanaProjects();
  check('project cache readable by the routing table', projects.length === 2, projects);

  // 1. Tick two tasks, keep the rest-walk ticked.
  answer = (items, sel) => [...sel, ...items.filter((i) => i.task && ['1218000000111', '1218000000222'].includes(i.task.gid))];
  launches.length = 0;
  check('ticked run reports a start', await nt.pickFromQueue('today+input'));
  const [a, b, rest] = launches;
  check('three launches: two tasks and the rest', launches.length === 3, launches.map((l) => l.dir));
  check('new task gets a slug folder under its client', a && a.dir === path.join(clients, 'BB', 'printer-offline'), a && a.dir);
  check('task tab carries the pin', a && a.namePrefix === '📌 ', a);
  check('task prompt names the task and forbids a copy', a && /Asana task "✨ Printer offline again" \(1218000000111\).*do NOT create a second one/.test(a.initialPrompt), a && a.initialPrompt);
  check('task already stamped with its gid reuses its folder', b && b.dir === path.join(clients, 'RAH', 'old-work'), b && b.dir);
  check('rest-walk skips exactly the ticked gids', rest && rest.initialPrompt === '/inbox-zero today+input skip 1218000000111,1218000000222', rest && rest.initialPrompt);
  check('rest-walk runs in home', rest && rest.dir === tmp, rest && rest.dir);

  // 2. Enter on the untouched list = the old full walk.
  answer = (_items, sel) => sel;
  launches.length = 0;
  await nt.pickFromQueue('input');
  check('untouched Enter = full walk, no skip', launches.length === 1 && launches[0].initialPrompt === '/inbox-zero input', launches);

  // 3. Esc starts nothing.
  answer = () => null;
  launches.length = 0;
  check('Esc reports nothing started', !(await nt.pickFromQueue('today')));
  check('Esc launches nothing', launches.length === 0, launches);

  // 4. Only tasks, rest-walk unticked.
  answer = (items) => items.filter((i) => i.task && i.task.gid === '1218000000333');
  launches.length = 0;
  await nt.pickFromQueue('today');
  check('rest-walk unticked = only the task tab', launches.length === 1 && launches[0].namePrefix === '📌 ', launches);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
