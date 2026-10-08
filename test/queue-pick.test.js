#!/usr/bin/env node
// Tests the queue checklist behind 📅 / ⏳ / 📥: the real pickFromQueue out of
// lib/newtask.js, a fake `asana` CLI printing a fixed queue, and a temp clients tree.
// VS Code and the terminal launch are stubbed; every launch is recorded instead.
//
// What it pins down: a ticked task opens in its client's folder (the one stamped with
// its gid when there is one), the rest-walk skips exactly the ticked gids, Enter on the
// untouched list is the old full walk, and Esc starts nothing. That is the visible-tab
// mode (no dtach); in the tab-less mode a ticked task goes to the Queue view instead of
// a tab. In both modes only the rest-walk row starts ticked.
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
  check('each tab opens only once the previous one has its shell', launches.every((l) => l.prevReady), launches.map((l) => l.prevReady));

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

  // 5. Tab-less mode: only the rest-walk row pre-ticked, as in tab mode.
  tabless = true;
  let seen;
  answer = (items, sel) => { seen = { items, sel: sel.slice() }; return sel; };
  launches.length = 0; queued.length = 0;
  check('tab-less: Enter on the untouched list = full walk', await nt.pickFromQueue('today+input') && queued.length === 0
    && launches.length === 1 && launches[0].initialPrompt === '/inbox-zero today+input', { queued, launches });
  check('tab-less: only the rest row pre-ticked', seen.sel.length === 1 && seen.sel[0].rest, seen.sel.map((i) => i.label));

  // Untick one, tick the rest-walk row: two queued, the walk skips exactly those two.
  answer = (items, sel) => [...sel, ...items.filter((i) => i.task && i.task.gid !== '1218000000333')];
  launches.length = 0; queued.length = 0;
  await nt.pickFromQueue('today+input');
  check('tab-less: unticked task is not queued', queued.length === 1 && queued[0].join() === '1218000000111,1218000000222', queued);
  check('tab-less: rest-walk skips exactly the queued gids', launches.length === 1 && launches[0].initialPrompt === '/inbox-zero today+input skip 1218000000111,1218000000222', launches);

  // Only the rest-walk row ticked: the old full walk, nothing queued.
  answer = (items) => [items.find((i) => i.rest)];
  launches.length = 0; queued.length = 0;
  await nt.pickFromQueue('input');
  check('tab-less: only the walk ticked = full walk, nothing queued', queued.length === 0 && launches.length === 1 && launches[0].initialPrompt === '/inbox-zero input', { queued, launches });

  // 6. Waiting-on-event tasks: last, under their own separator, out of the title count.
  fs.writeFileSync(path.join(tmp, 'q.json'), JSON.stringify([waitingTask, ...queue]));
  let qpSeen;
  const origCreate = vscode.window.createQuickPick;
  vscode.window.createQuickPick = () => { qpSeen = origCreate(); return qpSeen; };
  answer = () => null;
  await nt.pickFromQueue('today');
  vscode.window.createQuickPick = origCreate;
  const labels = qpSeen.items.map((i) => i.label);
  check('waiting: title counts only the rest', qpSeen.title === '📅 Today — 3 tasks + 1 waiting', qpSeen.title);
  check('waiting: separator then the waiting task, last', labels[labels.length - 2].startsWith('🕓 Waiting on event')
    && qpSeen.items[labels.length - 2].kind === vscode.QuickPickItemKind.Separator && labels[labels.length - 1] === '🕓 Backup after SRV001', labels);
  check('waiting: description gives the word without a second icon', qpSeen.items[labels.length - 1].description.startsWith('Waiting on event ·'), qpSeen.items[labels.length - 1].description);
  fs.writeFileSync(path.join(tmp, 'q.json'), JSON.stringify(queue));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
