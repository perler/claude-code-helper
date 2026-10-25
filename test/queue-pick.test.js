#!/usr/bin/env node
// Tests the queue checklist behind 📅 / ⏳ / 📥: the real pickFromQueue out of
// lib/newtask.js, a fake `asana` CLI printing a fixed queue, and a temp clients tree.
// VS Code and the terminal launch are stubbed; every launch is recorded instead.
//
// What it pins down (2026-10-14 layout: two title-bar buttons, ▶/↗ per row): 💬 walks the
// ticked tasks in one inbox-zero session, nothing ticked the whole queue; ☰ — and OK, which
// VS Code will not hide — opens a tab per ticked task in its client's folder (the one stamped
// with its gid when there is one), or hands them to the Queue view in the tab-less mode; OK
// with nothing ticked starts nothing; ▶ opens one row now; ↗ opens Asana and keeps the list.
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
// Shown separately (test 7): a waiting-on-event task the CLI put last with its marker.
const waitingTask = { gid: '1218000000444', name: 'Backup after SRV001', priority_marker: '🕓', queue_group: 'waiting',
  projects: [{ gid: 'p-bb', name: 'BB EDV' }], custom_fields: [{ enum_value: { name: '🕓 Waiting on event' } }] };
const cli = path.join(tmp, 'asana');
fs.writeFileSync(cli, `#!/bin/sh\n[ "$1" = queue ] && cat ${JSON.stringify(path.join(tmp, 'q.json'))}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(tmp, 'q.json'), JSON.stringify(queue));
fs.mkdirSync(path.join(tmp, '.cache', 'claude-code-helper'), { recursive: true });
process.env.HOME = tmp;
fs.mkdirSync(path.join(tmp, '.cache', 'claude-code-helper'), { recursive: true });

// ─── stubs ───────────────────────────────────────────────────────────────────
let script = null;   // (qp, h) => drives the picker once shown, the way Pat would
const opened = [];   // URLs handed to the browser (↗)
const settings = { asanaCommand: cli, clientsDir: clients, projectsDir: path.join(tmp, 'projects'), scratchDir: path.join(tmp, 'tasks') };
const vscode = {
  QuickPickItemKind: { Separator: -1 },
  ProgressLocation: { Window: 10 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  Uri: { parse: (u) => u, file: (f) => f },
  env: { openExternal: (u) => { opened.push(u); } },
  workspace: { getConfiguration: () => ({ get: (k) => settings[k] }) },
  window: {
    withProgress: (_o, fn) => fn(),
    showWarningMessage: (m) => { throw new Error('unexpected warning: ' + m); },
    showErrorMessage: (m) => { throw new Error('unexpected error: ' + m); },
    createQuickPick() {
      const h = {};
      const qp = { items: [], selectedItems: [], buttons: [], hidden: false,
        onDidAccept: (f) => { h.accept = f; }, onDidHide: (f) => { h.hide = f; },
        onDidTriggerButton: (f) => { h.button = f; }, onDidTriggerItemButton: (f) => { h.item = f; },
        dispose() {}, hide() { if (qp.hidden) return; qp.hidden = true; setImmediate(() => h.hide()); },
        show: () => setImmediate(() => script(qp, h)) };
      lastQp = qp;
      return qp;
    },
  },
};
let lastQp = null;
const launches = [];
let tabless = false;
const queued = [];   // what the (stubbed) Queue view was handed, one array of gids per call
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscode;
  // Each fake terminal's shell comes up 50 ms after its launch; `ready` records that, so
  // the test can see whether the next tab waited for it.
  if (req === './queue') return { addTasks: (tasks) => { queued.push(tasks.map((t) => t.gid)); return tasks.length; }, setQueueHooks: () => {} };
  if (req === './launch') return { tablessAvailable: () => tabless, startDtachMaster: async () => { throw new Error('unexpected tabless launch'); }, launchClaude: async (fav, resume, opts) => {
    const l = { dir: fav.path, label: fav.label, resume, ...opts, ready: false, prevReady: launches.length ? launches[launches.length - 1].ready : true };
    launches.push(l);
    return { processId: new Promise((r) => setTimeout(() => { l.ready = true; r(4242); }, 50)) };
  } };
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
  const tasks = (qp) => qp.items.filter((i) => i.task);
  const tick = (qp, ...gids) => { qp.selectedItems = tasks(qp).filter((i) => gids.includes(i.task.gid)); };
  const [walkBtn, queueBtn] = [0, 1];

  // 1. Tick two, 💬: one inbox-zero session over just those two, in home.
  script = (qp, h) => { tick(qp, '1218000000111', '1218000000222'); h.button(qp.buttons[walkBtn]); };
  launches.length = 0;
  check('💬 with ticks reports a start', await nt.pickFromQueue('today+input'));
  check('💬 with ticks = one walk over only those gids', launches.length === 1
    && launches[0].initialPrompt === '/inbox-zero today+input only 1218000000111,1218000000222', launches);
  check('💬 walk runs in home and says how many', launches[0] && launches[0].dir === tmp
    && launches[0].label === 'inbox-zero · Today + Input (2 picked)', launches[0]);

  // 2. Nothing ticked, 💬: the whole queue.
  script = (qp, h) => h.button(qp.buttons[walkBtn]);
  launches.length = 0;
  await nt.pickFromQueue('input');
  check('💬 with nothing ticked = full walk', launches.length === 1 && launches[0].initialPrompt === '/inbox-zero input', launches);

  // 3. Tick two, ☰ (visible-tab mode): a tab each, in its client's folder.
  script = (qp, h) => { tick(qp, '1218000000111', '1218000000222'); h.button(qp.buttons[queueBtn]); };
  launches.length = 0;
  check('☰ reports a start', await nt.pickFromQueue('today+input'));
  const [a, b] = launches;
  check('☰ = two task tabs, no walk', launches.length === 2 && launches.every((l) => l.namePrefix === '📌 '), launches.map((l) => l.dir));
  check('new task gets a slug folder under its client', a && a.dir === path.join(clients, 'BB', 'printer-offline'), a && a.dir);
  check('task prompt names the task and forbids a copy', a && /Asana task "✨ Printer offline again" \(1218000000111\).*do NOT create a second one/.test(a.initialPrompt), a && a.initialPrompt);
  check('task already stamped with its gid reuses its folder', b && b.dir === path.join(clients, 'RAH', 'old-work'), b && b.dir);
  check('each tab opens only once the previous one has its shell', launches.every((l) => l.prevReady), launches.map((l) => l.prevReady));

  // 4. OK does what ☰ does; with nothing ticked it starts nothing.
  script = (qp, h) => { tick(qp, '1218000000333'); h.accept(); };
  launches.length = 0;
  await nt.pickFromQueue('today');
  check('OK with a tick = that task tab', launches.length === 1 && launches[0].namePrefix === '📌 ', launches);
  script = (qp, h) => h.accept();
  launches.length = 0;
  check('OK with nothing ticked reports nothing started', !(await nt.pickFromQueue('today')));
  check('OK with nothing ticked launches nothing', launches.length === 0, launches);

  // 5. ▶ on a row opens that task now, whatever is ticked.
  script = (qp, h) => { tick(qp, '1218000000111'); const it = tasks(qp).find((i) => i.task.gid === '1218000000333'); h.item({ item: it, button: it.buttons[1] }); };
  launches.length = 0;
  await nt.pickFromQueue('today');
  check('▶ opens just that row', launches.length === 1 && launches[0].namePrefix === '📌 ' && launches[0].dir.startsWith(path.join(clients, 'BB', 'something-else')), launches.map((l) => l.dir));

  // 6. ↗ opens Asana and leaves the list open; Esc then starts nothing.
  script = (qp, h) => { const it = tasks(qp)[0]; h.item({ item: it, button: it.buttons[0] }); setImmediate(() => { check('↗ leaves the list open', !qp.hidden); qp.hide(); }); };
  launches.length = 0; opened.length = 0;
  check('↗ then Esc reports nothing started', !(await nt.pickFromQueue('today')));
  check('↗ opens the task in Asana', opened.length === 1 && /1218000000111$/.test(opened[0]) && launches.length === 0, { opened, launches });

  // 7. Tab-less mode: ☰ hands the ticks to the Queue view, no tab; 💬 still walks.
  tabless = true;
  script = (qp, h) => { tick(qp, '1218000000111', '1218000000222'); h.button(qp.buttons[queueBtn]); };
  launches.length = 0; queued.length = 0;
  await nt.pickFromQueue('today+input');
  check('tab-less: ☰ queues the ticks', queued.length === 1 && queued[0].join() === '1218000000111,1218000000222' && launches.length === 0, { queued, launches });
  script = (qp, h) => h.button(qp.buttons[walkBtn]);
  launches.length = 0; queued.length = 0;
  await nt.pickFromQueue('input');
  check('tab-less: 💬 = full walk, nothing queued', queued.length === 0 && launches.length === 1 && launches[0].initialPrompt === '/inbox-zero input', { queued, launches });
  tabless = false;

  // 8. Waiting-on-event tasks: last, under their own separator, out of the title count.
  fs.writeFileSync(path.join(tmp, 'q.json'), JSON.stringify([waitingTask, ...queue]));
  script = (qp) => qp.hide();
  await nt.pickFromQueue('today');
  const qpSeen = lastQp;
  const labels = qpSeen.items.map((i) => i.label);
  check('waiting: title counts only the rest', qpSeen.title === '📅 Today — 3 tasks + 1 waiting', qpSeen.title);
  check('waiting: separator then the waiting task, last', labels[labels.length - 2].startsWith('🕓 BB EDV — waiting on event')
    && qpSeen.items[labels.length - 2].kind === vscode.QuickPickItemKind.Separator && labels[labels.length - 1] === '🕓 Backup after SRV001', labels);
  check('waiting: description gives the word without a second icon', qpSeen.items[labels.length - 1].description.startsWith('Waiting on event'), qpSeen.items[labels.length - 1].description);
  fs.writeFileSync(path.join(tmp, 'q.json'), JSON.stringify(queue));

  // 9. A task a live session already works is left out: one through its stamped folder
  // (RAH old-work, gid …222), one through the task line its transcript opens with, as a
  // repo-folder session has no stamp (…111). This process stands in for the live claude.
  const sessDir = path.join(tmp, '.claude', 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const repo = path.join(tmp, 'projects', 'zentrale');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(sessDir, '1.json'), JSON.stringify({ pid: process.pid, sessionId: 's-stamped', cwd: path.join(clients, 'RAH', 'old-work') }));
  fs.writeFileSync(path.join(sessDir, '2.json'), JSON.stringify({ pid: process.pid, sessionId: 's-repo', cwd: repo }));
  const tdir = path.join(tmp, '.claude', 'projects', repo.replace(/\//g, '-'));
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 's-repo.jsonl'), JSON.stringify({ type: 'attachment', content: 'x'.repeat(200000) }) + '\n'
    + JSON.stringify({ type: 'user', message: { content: 'This is Asana task "✨ Printer offline again" (1218000000111) — work it there; do NOT create a second one.' } }) + '\n');
  script = (qp) => qp.hide();
  await nt.pickFromQueue('today');
  check('open in a session: both left out', tasks(lastQp).map((i) => i.task.gid).join() === '1218000000333', tasks(lastQp).map((i) => i.task.gid));
  check('open in a session: title says how many', lastQp.title === '📅 Today — 1 task · 2 open in a session, not shown', lastQp.title);

  // 10. A 💬 walk of picked tasks: its /inbox-zero … only <gids> names them all (…333 here).
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(sessDir, '3.json'), JSON.stringify({ pid: process.pid, sessionId: 's-walk', cwd: home }));
  const wdir = path.join(tmp, '.claude', 'projects', home.replace(/\//g, '-'));
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, 's-walk.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-message>inbox-zero</command-message>\n<command-name>/inbox-zero</command-name>\n<command-args>today only 1218000000333,1218000000999</command-args>' } }) + '\n');
  await nt.pickFromQueue('today');
  check('walked in a session: left out', tasks(lastQp).length === 0, tasks(lastQp).map((i) => i.task.gid));
  fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
