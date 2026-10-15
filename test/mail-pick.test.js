#!/usr/bin/env node
// Tests the ✉️ mail checklist (2026-10-15, aligned with the queue picker): the real
// pickFromMail and startMailTriage out of lib/newtask.js, VS Code and the launch stubbed.
//
// What it pins down: Enter on the untouched list = the whole-inbox triage prompt, exactly
// triagePrompt(cmd); two ticks = a triage over just those two; one tick and ▶ = the single-
// mail route; ↗ opens Gmail and leaves the list open; Esc starts nothing.
//
// Run: node test/mail-pick.test.js
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-mail-'));
process.env.HOME = tmp;
const settings = { mailInboxCommand: 'mail-inbox --json', clientsDir: path.join(tmp, 'c'), projectsDir: path.join(tmp, 'p'), scratchDir: path.join(tmp, 't') };

let script = null;   // (qp) => drives the picker once shown
const opened = [];
const vscode = {
  QuickPickItemKind: { Separator: -1 }, ProgressLocation: { Window: 10 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  Uri: { parse: (u) => u, file: (f) => f },
  env: { openExternal: (u) => { opened.push(u); } },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) },
  window: {
    createQuickPick() {
      const h = {};
      const qp = { items: [], selectedItems: [], buttons: [], hidden: false,
        onDidAccept: (f) => { h.accept = f; }, onDidHide: (f) => { h.hide = f; },
        onDidTriggerButton: (f) => { h.button = f; }, onDidTriggerItemButton: (f) => { h.item = f; },
        dispose() {}, hide() { qp.hidden = true; setImmediate(() => h.hide()); },
        show: () => setImmediate(() => { script && script(qp, h); }) };
      qp.h = h;
      return qp;
    },
  },
};
const launches = [];
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return vscode;
  if (req === './launch') return { tablessAvailable: () => false, launchClaude: async (fav, resume, opts) => { launches.push({ label: fav.label, ...opts }); return true; } };
  return origLoad.apply(this, arguments);
};
const nt = require('../lib/newtask');
const { triagePrompt, mailInboxCommand } = require('../lib/mail');

let failed = 0;
const check = (n, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' — ' + JSON.stringify(d)}`); if (!c) failed++; };

const list = [
  { subject: 'Printer offline', from: 'Anna', date: '2026-10-14', unread: true, thread_link: 'https://mail.google.com/mail/u/0/#inbox/aaa' },
  { subject: 'Invoice question', from_address: 'bob@x.de', date: '2026-10-13', unread: false },
  { subject: 'Backup alert', from: 'Healthchecks', date: '2026-10-12', unread: true, thread_link: 'https://mail.google.com/mail/u/0/#inbox/ccc' },
];
const post = () => {};
// Runs the picker with a script; returns what the callbacks received.
async function run(drive) {
  const got = { one: [], triage: [] };
  let qpSeen;
  script = (qp, h) => { qpSeen = qp; drive(qp, h); };
  await nt.pickFromMail(list, { one: (m) => got.one.push(m), triage: (ms) => got.triage.push(ms) });
  return { got, qp: qpSeen };
}
const tick = (qp, ...idx) => { qp.selectedItems = idx.map((i) => qp.items[i]); };

(async () => {
  // 1. Enter on the untouched list = whole inbox.
  let r = await run((qp, h) => h.accept());
  check('untouched Enter = triage of all (empty list)', r.got.one.length === 0 && r.got.triage.length === 1 && r.got.triage[0].length === 0, r.got);
  check('nothing ticked at start', r.qp.selectedItems.length === 0);
  check('title counts the mails', r.qp.title === '✉️ Inbox — 3 mails', r.qp.title);
  // Bitwarden's test (apps/browser/src/autofill/utils/qualification.ts): lowercase, drop
  // hyphens and whitespace, look for a login keyword anywhere. A hit pops its drop-down.
  const bw = (t) => ['email', 'username', 'login', 'userid'].filter((k) => t.toLowerCase().replace(/[-\s]/g, '').includes(k));
  check('placeholder is not a login field to Bitwarden', bw(r.qp.placeholder).length === 0, r.qp.placeholder);
  check('title is not a login field to Bitwarden', bw(r.qp.title).length === 0, r.qp.title);
  check('row buttons: ↗ only with a thread link', r.qp.items[0].buttons.length === 2 && r.qp.items[1].buttons.length === 1 && r.qp.items[1].buttons[0].iconPath.id === 'play', r.qp.items.map((i) => i.buttons.length));
  check('title button is 💬', r.qp.buttons.length === 1 && r.qp.buttons[0].iconPath.id === 'comment-discussion');
  check('canSelectMany set', r.qp.canSelectMany === true);

  // 2. 💬 with nothing ticked = same.
  r = await run((qp, h) => h.button(qp.buttons[0]));
  check('💬 untouched = triage of all', r.got.triage.length === 1 && r.got.triage[0].length === 0, r.got);

  // 3. Two ticks.
  r = await run((qp, h) => { tick(qp, 0, 2); h.accept(); });
  check('two ticks = one triage over those two', r.got.one.length === 0 && r.got.triage.length === 1
    && r.got.triage[0].map((m) => m.subject).join() === 'Printer offline,Backup alert', r.got);

  // 4. One tick = single-mail route.
  r = await run((qp, h) => { tick(qp, 1); h.accept(); });
  check('one tick = routed as a single mail', r.got.triage.length === 0 && r.got.one.length === 1 && r.got.one[0].subject === 'Invoice question', r.got);

  // 5. ▶ on a row.
  r = await run((qp, h) => h.item({ button: qp.items[2].buttons[1], item: qp.items[2] }));
  check('▶ routes that one mail', r.got.one.length === 1 && r.got.one[0].subject === 'Backup alert' && r.got.triage.length === 0, r.got);
  check('▶ hides the list', r.qp.hidden);

  // 6. ↗ opens Gmail, list stays, then Esc.
  opened.length = 0;
  r = await run((qp, h) => { h.item({ button: qp.items[0].buttons[0], item: qp.items[0] }); const stillOpen = !qp.hidden; opened.push(stillOpen); qp.hide(); });
  check('↗ opens the thread link and keeps the list open', opened[0] === list[0].thread_link && opened[1] === true && r.got.one.length + r.got.triage.length === 0, opened);

  // 7. Esc.
  r = await run((qp) => qp.hide());
  check('Esc starts nothing', r.got.one.length === 0 && r.got.triage.length === 0, r.got);

  // 8. The launch: all = identical prompt, picked = listed subjects only.
  launches.length = 0;
  await nt.startMailTriage([], post);
  check('all: prompt identical to triagePrompt(cmd)', launches[0].initialPrompt === triagePrompt(mailInboxCommand()) && launches[0].label === 'mail triage', launches[0]);
  launches.length = 0;
  await nt.startMailTriage([list[0], list[2]], post);
  const p = launches[0].initialPrompt;
  check('two picked: label', launches[0].label === 'mail triage (2 picked)', launches[0].label);
  check('two picked: lists exactly those two, not the third',
    p.includes('1. Printer offline — Anna — 2026-10-14 — https://mail.google.com/mail/u/0/#inbox/aaa') && p.includes('2. Backup alert')
    && !p.includes('Invoice question') && p.includes('these 2 mails'), p);
  check('picked prompt keeps the table and approval rules', /ONE numbered table/.test(p) && /before I approve its row/.test(p));
  check('no mails argument = same text as an empty list', triagePrompt('x') === triagePrompt('x', []));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
