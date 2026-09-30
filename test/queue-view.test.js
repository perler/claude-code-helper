#!/usr/bin/env node
// Tests the Queue view's logic: the state of a row, the sort order, the five-at-a-time
// scheduler, "never launch a task twice", and that the rows survive a reload. The real
// lib/queue.js and lib/tabstate.js run against real state files under a temp HOME; only
// VS Code, the launcher and the session registry are stubbed.
//
// Run: node test/queue-view.test.js
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), Module = require('module');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-qview-'));
process.env.HOME = HOME;
const stateDir = path.join(HOME, '.cache', 'claude-tab-state');
const sessionsDir = path.join(HOME, '.claude', 'sessions');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });

const vscode = {
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class { constructor(label) { this.label = label; } },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0 },
  commands: { executeCommand: () => {} },
  window: { terminals: [], showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {} },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return vscode;
  if (req === './launch') return { dtachAttachCmd() {}, dtachStealCmd() {}, launchIcon() {}, moveTerminalTabToEnd() {}, rememberTabName() {} };
  if (req === './session-registry') return { registerSessionTerminal() {}, sessionDtachSocket: () => null };
  return origLoad.apply(this, arguments);
};
const q = require('../lib/queue');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + JSON.stringify(detail)}`);
  if (!cond) failed++;
}

const NOW = 1_000_000_000_000;
const started = (extra) => ({ gid: 'g', order: 1, sessionId: 's', startedAt: NOW - 10 * 60e3, ...extra });   // started 10 min ago
const ev = (extra) => ({ alive: true, live: undefined, file: undefined, seen: false, ...extra });

// ─── 1. the state of one row ────────────────────────────────────────────────
const S = (row, e) => q.rowState(row, e, NOW);
check('not started = queued', S({ gid: 'g', startedAt: null }, ev()) === 'queued');
check('not started, no folder = needs folder', S({ gid: 'g', startedAt: null, needsFolder: true }, ev()) === 'needsFolder');
check('a start that failed = failed', S({ gid: 'g', startedAt: null, failed: 'x' }, ev()) === 'failed');
check('asking: the hook says input', S(started(), ev({ file: 'input' })) === 'asking');
check('asking: the CLI says waiting beats an old working file', S(started(), ev({ live: 'input', file: 'working' })) === 'asking');
check('finished, unread', S(started(), ev({ file: 'ended', live: 'idle' })) === 'finished');
check('finished, read = seen', S(started(), ev({ file: 'ended', live: 'idle', seen: true })) === 'seen');
check('working: the CLI says busy over a finished file', S(started(), ev({ live: 'working', file: 'ended' })) === 'working');
check('alive, idle, no hook file = seen', S(started(), ev({ live: 'idle' })) === 'seen');
check('claimed long ago, no session ever came up = queued again', S({ gid: 'g', startedAt: NOW - 10 * 60e3, claimedBy: 'w' }, ev({ alive: false })) === 'queued');
check('claimed just now, no session yet = working (counts for the cap)', S({ gid: 'g', startedAt: NOW - 5000, claimedBy: 'w' }, ev({ alive: false })) === 'working');
check('process gone long ago = ended', S(started(), ev({ alive: false, file: 'working' })) === 'ended');
check('process not up yet, just started = working', S({ gid: 'g', startedAt: NOW - 5000 }, ev({ alive: false })) === 'working');
check('just started, no file yet, alive = working', S({ gid: 'g', startedAt: NOW - 5000 }, ev()) === 'working');

// ─── 2. the sort order ──────────────────────────────────────────────────────
const mk = (gid, order) => ({ gid, order });
const rows = [mk('ended1', 1), mk('queued1', 2), mk('working1', 3), mk('seen1', 4), mk('finished1', 5), mk('asking1', 6),
  mk('queued0', 0), mk('asking0', -1), mk('folder1', 7)];
const states = new Map([['ended1', 'ended'], ['queued1', 'queued'], ['working1', 'working'], ['seen1', 'seen'],
  ['finished1', 'finished'], ['asking1', 'asking'], ['queued0', 'queued'], ['asking0', 'asking'], ['folder1', 'needsFolder']]);
const sorted = q.sortRows(rows, states).map((r) => r.gid);
check('asking, finished, working, queued, then seen and ended (ties in queue order)',
  sorted.join() === 'asking0,asking1,finished1,folder1,working1,queued0,queued1,seen1,ended1', sorted);

// ─── 3. the scheduler's arithmetic ──────────────────────────────────────────
const many = Array.from({ length: 12 }, (_, i) => ({ gid: 't' + (i + 1), order: i + 1 }));
const st = (over) => new Map(many.map((r) => [r.gid, over[r.gid] || 'queued']));
let pick = q.nextToStart(many, st({}), 5).map((r) => r.gid);
check('cap 5, nothing running: the first five in queue order', pick.join() === 't1,t2,t3,t4,t5', pick);
pick = q.nextToStart(many, st({ t1: 'working', t2: 'working', t3: 'working' }), 5).map((r) => r.gid);
check('three working: two more start', pick.join() === 't4,t5', pick);
pick = q.nextToStart(many, st({ t1: 'working', t2: 'working', t3: 'working', t4: 'working', t5: 'working' }), 5);
check('five working: nothing starts', pick.length === 0, pick);
pick = q.nextToStart(many, st({ t1: 'working', t2: 'asking', t3: 'working', t4: 'working', t5: 'working' }), 5).map((r) => r.gid);
check('one asks: its slot goes to the next queued task', pick.join() === 't6', pick);
pick = q.nextToStart(many, st({ t1: 'needsFolder', t2: 'failed', t3: 'ended' }), 5).map((r) => r.gid);
check('needs-folder, failed and ended rows neither block nor start', pick.join() === 't4,t5,t6,t7,t8', pick);
check('the cap is five', q.MAX_WORKING === 5);

// ─── 4. no double launch ────────────────────────────────────────────────────
const tasks = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ gid: String(from + i), name: `✨ Task ${from + i}`, projects: [{ gid: 'p', name: 'P' }] }));
let merged = q.mergeTasks([], tasks(3), new Map());
check('new tasks get rows in order', merged.added.join() === '1,2,3' && merged.rows.map((r) => r.order).join() === '1,2,3', merged);
check('the row keeps only what folder resolution reads', JSON.stringify(Object.keys(merged.rows[0].task).sort()) === '["gid","homeless","name","permalink_url","projects"]', merged.rows[0].task);
check('the row name loses the house sparkle', merged.rows[0].name === 'Task 1');
const again = q.mergeTasks(merged.rows, tasks(2, 2), new Map([['2', 'working'], ['3', 'queued']]));
check('a task with a live or waiting row is skipped, not launched twice', again.added.length === 0 && again.skipped.join() === '2,3' && again.rows.length === 3, again);
const redo = q.mergeTasks(merged.rows, tasks(2, 2), new Map([['2', 'ended'], ['3', 'failed']]));
check('a dead row is replaced, going to the back of the queue', redo.added.join() === '2,3' && redo.rows.map((r) => r.gid).join() === '1,2,3' && redo.rows.find((r) => r.gid === '2').order === 4, redo.rows.map((r) => [r.gid, r.order]));

// ─── 5. the scheduler end to end: store, pump, real state files ────────────
const rowsFile = q.queueFile();
q.initQueue();
const startedGids = [];
let startBehaviour = (row) => ({ folder: '/w/' + row.gid, sessionId: 'sid-' + row.gid, socket: '/s/' + row.gid + '.sock', tabId: crypto.randomUUID() });
q.setQueueHooks({ start: async (row) => { startedGids.push(row.gid); return startBehaviour(row); }, pickFolder: async () => ({ id: 'x', name: 'X', dir: '/x' }) });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const rowsNow = () => JSON.parse(fs.readFileSync(rowsFile, 'utf8'));
const store = () => rowsNow().reduce((m, r) => (m[r.gid] = r, m), {});
// A live session as the CLI would report it: a session file naming a real pid.
const liveSession = (row) => fs.writeFileSync(path.join(sessionsDir, row.sessionId + '.json'), JSON.stringify({ pid: process.pid, sessionId: row.sessionId, status: 'busy' }));
const hookWord = (row, word) => fs.writeFileSync(path.join(stateDir, row.tabId), word);

(async () => {
  check('twelve tasks are queued', q.addTasks(tasks(12)) === 12);
  await settle();
  check('only five start, in queue order', startedGids.join() === '1,2,3,4,5', startedGids);
  check('the rest wait', Object.values(store()).filter((r) => !r.startedAt).length === 7);

  // Task 2 asks a question: its process is alive and its hook file says input.
  let s = store();
  for (const g of ['1', '2', '3', '4', '5']) liveSession(s[g]);
  hookWord(s['2'], 'input');
  hookWord(s['1'], 'working');
  q.tick(); await settle();
  check('a session that asks frees its slot for the next task', startedGids.join() === '1,2,3,4,5,6', startedGids);

  // Task 3 finishes its turn (unread): frees a slot too.
  hookWord(store()['3'], 'ended');
  q.tick(); await settle();
  check('a session that finishes frees its slot', startedGids.join() === '1,2,3,4,5,6,7', startedGids);

  // Task 4 dies. Inside the start grace a missing process only means "not up yet".
  fs.unlinkSync(path.join(sessionsDir, 'sid-4.json'));
  q.tick(); await settle();
  check('a dead process inside the start grace still counts as working (no early slot)', startedGids.length === 7, startedGids);

  // Past the grace period it is ended. Age it in the persisted copy and reload, as a
  // window reload would, then check what comes back.
  const age4 = (r) => (r.gid === '4' ? { ...r, startedAt: Date.now() - q.START_GRACE_MS - 5000 } : r);
  const writeRows = (rows) => fs.writeFileSync(rowsFile, JSON.stringify(rows));
  const aged = rowsNow().map(age4);
  writeRows(aged);
  const reloaded = new q.QueueStore(rowsFile);
  const reStates = q.computeStates(reloaded.rows);
  check('a persisted row comes back with its states recomputed from the files', reStates.get('2') === 'asking' && reStates.get('3') === 'finished' && reStates.get('4') === 'ended' && reStates.get('1') === 'working', [...reStates]);
  check('round trip keeps every field of every row', JSON.stringify(reloaded.rows) === JSON.stringify(aged));
  const pickAfterReload = q.nextToStart(reloaded.rows, reStates).map((r) => r.gid);
  check('after a reload the queued ones resume, respecting the cap (1, 5, 6, 7 work)', pickAfterReload.join() === '8', pickAfterReload);

  // A task queued again while its row is live is not launched a second time.
  const before = startedGids.length;
  check('re-adding a live task adds nothing', q.addTasks(tasks(1, 1)) === 0);
  await settle();
  check('and starts nothing for it (its slot-mates start, task 1 does not)', !startedGids.slice(before).includes('1'), startedGids);

  // Reload for real (new store on the same memento): row 8 cannot be placed, and must
  // not hold up 9 and 10, which take the slot it gives back within the same pump.
  const ageN = (n) => (r) => (r.gid === n ? { ...r, startedAt: Date.now() - q.START_GRACE_MS - 5000 } : r);
  startBehaviour = (row) => (row.gid === '9' ? { needsFolder: true } : { folder: '/w/' + row.gid, sessionId: 'sid-' + row.gid, socket: '/s', tabId: crypto.randomUUID() });
  writeRows(rowsNow().map(age4).map(ageN('5')));
  q.initQueue();
  const tried = startedGids.length;
  q.tick(); await settle();
  s = store();
  check('a task that needs a folder is marked, not started', s['9'] && s['9'].needsFolder && !s['9'].startedAt, s['9']);
  check('and the queue moves on past it, in the same pass', startedGids.slice(tried).join() === '9,10', startedGids.slice(tried));
  check('and the slot it gave back holds only one more (cap still five)', s['10'].startedAt && !s['11'].startedAt, s['11']);

  // A start that throws marks the row failed, and it is not retried by itself.
  startBehaviour = () => { throw new Error('boom'); };
  writeRows(rowsNow().map(ageN('6')));
  q.initQueue();
  q.tick(); await settle();
  const failedRows = Object.values(store()).filter((r) => r.failed);
  check('a failed start is marked failed', failedRows.length >= 1 && failedRows.every((r) => r.failed === 'boom' && !r.startedAt), failedRows);
  const attempts = startedGids.length;
  q.tick(); await settle();
  check('a failed row is not started again by itself', startedGids.filter((g) => failedRows.some((r) => r.gid === g)).length === startedGids.slice(0, attempts).filter((g) => failedRows.some((r) => r.gid === g)).length, startedGids);


  // ─── 6. several windows on one file ───────────────────────────────────────
  const file2 = path.join(HOME, 'other-queue.json');
  const A = new q.QueueStore(file2), B = new q.QueueStore(file2);
  A.update((rows) => q.mergeTasks(rows, tasks(2), new Map()).rows);
  check('a second store sees the first one\'s rows once it looks', B.rows.length === 0 && B.refresh() && B.rows.map((r) => r.gid).join() === '1,2', B.rows);
  check('and does not re-read while the file is unchanged', B.refresh() === false);
  // B is stale now? no — make A write again, B still holds the old copy and saves.
  A.update((rows) => q.mergeTasks(rows, tasks(1, 3), new Map()).rows);
  B.update((rows) => q.mergeTasks(rows, tasks(1, 4), new Map()).rows);
  A.refresh();
  check('a save from a stale store does not drop the other window\'s row', A.rows.map((r) => r.gid).join() === '1,2,3,4' && JSON.parse(fs.readFileSync(file2, 'utf8')).length === 4, A.rows.map((r) => r.gid));
  check('no temp or lock file is left behind', fs.readdirSync(HOME).filter((f) => /other-queue\.json\./.test(f)).length === 0, fs.readdirSync(HOME));

  // Two windows claim the same queued row, the second working from a copy read before the first won.
  const C = new q.QueueStore(file2), D = new q.QueueStore(file2);
  const winC = q.claimRow(C, '1', 'win-C');
  const winD = q.claimRow(D, '1', 'win-D');
  check('of two competing claims exactly one wins', winC === true && winD === false, { winC, winD });
  check('the loser sees the winner on the row', D.find('1').claimedBy === 'win-C' && D.find('1').startedAt > 0, D.find('1'));
  check('a row already claimed is not claimable by a third window inside the grace', q.claimRow(new q.QueueStore(file2), '1', 'win-E') === false);

  // A claim whose window died before a session came up returns to queued and can be claimed again.
  const dead = D.rows.map((r) => (r.gid === '1' ? { ...r, startedAt: Date.now() - q.START_GRACE_MS - 1000 } : r));
  fs.writeFileSync(file2, JSON.stringify(dead));
  D.refresh();
  check('a stale claim (no session, past the grace) is queued again', q.computeStates(D.rows).get('1') === 'queued', [...q.computeStates(D.rows)]);
  check('and another window can take it over', q.claimRow(D, '1', 'win-D') === true && D.find('1').claimedBy === 'win-D');
  // A claim that did produce a session is never stolen.
  fs.writeFileSync(file2, JSON.stringify(D.rows.map((r) => (r.gid === '1' ? { ...r, sessionId: 'x', startedAt: Date.now() - 3600e3 } : r))));
  check('a row with a session is not claimable, however old', q.claimRow(new q.QueueStore(file2), '1', 'win-F') === false);

  // A row removed while its session is starting: the session that then comes up is killed.
  const killed = [];
  const realSpawn = require('child_process').spawnSync;
  require('child_process').spawnSync = (cmd, args) => { killed.push([cmd, ...(args || [])]); return { status: 0 }; };
  let release;
  startBehaviour = (row) => new Promise((res) => { release = () => res({ folder: '/w/late', sessionId: 'sid-late', socket: '/s/late', tabId: crypto.randomUUID() }); });
  fs.writeFileSync(rowsFile, JSON.stringify(q.mergeTasks([], tasks(1, 900), new Map()).rows));
  q.initQueue();
  q.tick(); await new Promise((r) => setTimeout(r, 30));
  check('the row is claimed and waiting on its start', rowsNow()[0].claimedBy && !rowsNow()[0].sessionId, rowsNow());
  writeRows([]);                       // another window removed it
  release(); await settle();
  check('a session that starts for a removed row is killed', killed.some((k) => k[0] === 'pkill' && k.includes('sid-late')), killed);
  check('and leaves no row behind', rowsNow().length === 0, rowsNow());
  require('child_process').spawnSync = realSpawn;

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
