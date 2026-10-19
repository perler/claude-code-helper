#!/usr/bin/env node
// Tests the ✉️ mail picker (2026-10-15: click opens, tick button, 💬 works the ticked): the real
// pickFromMail and startMailTriage out of lib/newtask.js, VS Code and the launch stubbed.
//
// What it pins down: a row click = that one mail routed single; ☐/☑ hover button toggles without
// closing, keeps other ticks and the highlight; 💬 = none: whole-inbox triage, one: single route,
// several: triage over just those; ↗ opens Gmail and leaves the list open; Esc starts nothing.
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
      const qp = { items: [], selectedItems: [], activeItems: [], buttons: [], hidden: false,
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

(async () => {
  const tickBtn = (qp, i) => qp.items[i].buttons[qp.items[i].buttons.length - 1];
  const toggle = (qp, h, i) => h.item({ button: tickBtn(qp, i), item: qp.items[i] });

  // 1. Initial state, placeholder, title, buttons.
  let r = await run((qp) => qp.hide());
  check('nothing ticked at start, canSelectMany off', r.qp.canSelectMany !== true && r.qp.items.every((i) => i.label.startsWith('☐')), r.qp.items.map((i) => i.label));
  check('title counts the mails', r.qp.title === '✉️ Inbox — 3 mails', r.qp.title);
  // Bitwarden's test (apps/browser/src/autofill/utils/qualification.ts): lowercase, drop
  // hyphens and whitespace, look for a login keyword anywhere. A hit pops its drop-down.
  const bw = (t) => ['email', 'username', 'login', 'userid'].filter((k) => t.toLowerCase().replace(/[-\s]/g, '').includes(k));
  check('placeholder is not a login field to Bitwarden', bw(r.qp.placeholder).length === 0, r.qp.placeholder);
  check('title is not a login field to Bitwarden', bw(r.qp.title).length === 0, r.qp.title);
  check('placeholder has no "mail" at all', !/mail/.test(r.qp.placeholder.toLowerCase().replace(/[-\s]/g, '')), r.qp.placeholder);
  check('row buttons: ↗ only with a thread link, tick on every row, no ▶',
    r.qp.items[0].buttons.length === 2 && r.qp.items[1].buttons.length === 1
    && r.qp.items.every((i) => i.buttons.every((b) => !String(b.iconPath).endsWith('25b6.svg'))) && String(tickBtn(r.qp, 1).iconPath).endsWith('2610.svg'), r.qp.items.map((i) => i.buttons.length));
  check('title button is 💬', r.qp.buttons.length === 1 && String(r.qp.buttons[0].iconPath).endsWith('1f4ac.svg'));

  // 2. Clicking a row (Enter on it) = that one mail, routed single.
  r = await run((qp, h) => { qp.selectedItems = [qp.items[2]]; h.accept(); });
  check('row click routes that one mail', r.got.one.length === 1 && r.got.one[0].subject === 'Backup alert' && r.got.triage.length === 0, r.got);
  check('row click hides the list', r.qp.hidden);

  // 3. 💬 with nothing ticked = whole inbox.
  r = await run((qp, h) => h.button(qp.buttons[0]));
  check('💬 untouched = triage of all', r.got.triage.length === 1 && r.got.triage[0].length === 0, r.got);

  // 4. Tick toggle keeps the list open, keeps other ticks, restores the highlight.
  r = await run((qp, h) => {
    qp.activeItems = [qp.items[1]];
    toggle(qp, h, 0); toggle(qp, h, 2);
    const s = { open: !qp.hidden, labels: qp.items.map((i) => i.label[0]), title: qp.title,
      icon: String(tickBtn(qp, 0).iconPath), active: qp.activeItems.map((i) => i.mail.subject).join() };
    toggle(qp, h, 2);                       // untick again
    s.after = qp.items.map((i) => i.label[0]).join('');
    got4 = s; qp.hide();
  });
  var got4;
  check('tick keeps list open and shows ☑ on both', got4.open && got4.labels.join('') === '☑☐☑' && got4.icon.endsWith('2611.svg'), got4);
  check('tick keeps the highlighted row and counts in the title', got4.active === 'Invoice question' && got4.title.endsWith('2 ticked'), got4);
  check('untick clears just that one', got4.after === '☑☐☐', got4);
  check('ticking started nothing', r.got.one.length + r.got.triage.length === 0, r.got);

  // 5. Two ticks, then 💬.
  r = await run((qp, h) => { toggle(qp, h, 0); toggle(qp, h, 2); h.button(qp.buttons[0]); });
  check('two ticks + 💬 = one triage over those two (list order)', r.got.one.length === 0 && r.got.triage.length === 1
    && r.got.triage[0].map((m) => m.subject).join() === 'Printer offline,Backup alert', r.got);

  // 6. One tick + 💬 = single-mail route (incl. mail without a thread link).
  r = await run((qp, h) => { toggle(qp, h, 1); h.button(qp.buttons[0]); });
  check('one tick + 💬 = routed as a single mail', r.got.triage.length === 0 && r.got.one.length === 1 && r.got.one[0].subject === 'Invoice question', r.got);

  // 7. ↗ opens Gmail, list stays open (ticks kept), then Esc.
  opened.length = 0;
  r = await run((qp, h) => { toggle(qp, h, 0); h.item({ button: qp.items[0].buttons[0], item: qp.items[0] }); opened.push(!qp.hidden, qp.items[0].label[0]); qp.hide(); });
  check('↗ opens the thread link and keeps the list open and the tick', opened[0] === list[0].thread_link && opened[1] === true && opened[2] === '☑' && r.got.one.length + r.got.triage.length === 0, opened);
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
  check('picked prompt runs inbox-zero, scope mail only, one mail per round', /inbox-zero skill/.test(p) && /scope `mail only`/.test(p) && /AskUserQuestion/.test(p) && /before I approve it in its round/.test(p));
  const bad = /blocks of five|ONE numbered table|answer by number|5 at a time|one table/i;
  const pAll = triagePrompt(mailInboxCommand());
  check('no table / by-number / blocks-of-five wording in either prompt', !bad.test(p) && !bad.test(pAll), [p, pAll]);
  check('all prompt runs inbox-zero with scope mail', /inbox-zero skill/.test(pAll) && /scope `mail`/.test(pAll) && !/mail only/.test(pAll), pAll);
  check('no mails argument = same text as an empty list', triagePrompt('x') === triagePrompt('x', []));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
