const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');

const { openAsanaTask, taskProjects } = require('./asana');
const {
  dtachEnterCmd, launchIcon, moveTerminalTabToEnd, rememberTabName,
} = require('./launch');
const { registerSessionTerminal, sessionDtachSocket } = require('./session-registry');
const { dtachSocketDir, removeDtachLog } = require('./shared');
const {
  onTabStateTick, tabStateBadgeState, tabStateLive, tabStateProcAlive, tabStateReadAll, tabStateSeen,
  tabStateKeyForTerminal, tabStateSessionsDir, registerTabState,
} = require('./tabstate');
// ─── the Queue view ──────────────────────────────────────────────────────────
//
// A queue button used to open one visible tab per picked task, which is fine for three
// tasks and overwhelming for thirty. Now every task gets its own Claude session that
// runs with NO terminal tab (a detached dtach master, see startDtachMaster), and this
// view lists one row per task with its state, so only the ones that need Pat get
// opened. Clicking a row attaches a tab to that session's socket; closing the tab
// leaves the session running, exactly as a dtach attach always did.
//
// The state is not stored here — it is read from the same two sources the tab badges
// use (the hook state file per CCH_TAB_ID, and the CLI's own live session files), plus
// two states only this module knows: `queued` (not started yet) and `ended` (process
// gone). What IS stored, in globalState, is the row itself, so a window reload keeps
// the list: which task, which folder, which session, which socket, which tab id.

// At most this many sessions in state `working` at once. A session that asks, finishes
// or dies frees its slot for the next queued task. A constant, not a setting.
const MAX_WORKING = 5;

// A session's process needs a few seconds before the CLI writes its session file, so a
// row that has just been started counts as working, not as ended, for this long.
const START_GRACE_MS = 45 * 1000;

// Every window of the same code-server user shares the one list: it lives in a file, not in
// a window's own state, so rows show everywhere and no window saves a stale copy over a
// newer one. This id is what a window writes on a row when it claims it to start.
const WINDOW_ID = crypto.randomUUID();

function queueFile() { return path.join(os.homedir(), '.cache', 'claude-code-helper', 'queue.json'); }

// Order in the view: what needs Pat first. A task waiting for a folder needs him too,
// so it sits with the finished ones; `failed` is a dead row like `ended`.
const STATE_RANK = { asking: 0, finished: 1, needsFolder: 1, working: 2, queued: 3, seen: 4, failed: 4, ended: 5 };

const STATE_WORD = {
  asking: '? asking', finished: '! finished', needsFolder: 'needs folder', working: '* working',
  queued: 'queued', seen: 'seen', failed: 'could not start', ended: 'ended',
};

const STATE_ICON = {
  asking: ['question', 'list.warningForeground'], finished: ['bell', 'list.warningForeground'],
  needsFolder: ['folder', 'list.warningForeground'], working: ['sync~spin', 'terminal.ansiGreen'],
  queued: ['clock', 'disabledForeground'], seen: ['circle-outline', 'terminal.ansiBlue'],
  failed: ['error', 'list.errorForeground'], ended: ['vm-outline', 'disabledForeground'],
};

// ─── pure logic ──────────────────────────────────────────────────────────────

// One row's state. `ev` is what the two sources say about it right now:
// { alive, live, file, seen } — a live session of that id exists, the CLI's word for it,
// the hook file's word, and whether Pat has looked since its last finished turn.
function rowState(row, ev, now) {
  if (row.failed) return 'failed';
  const fresh = !!row.startedAt && now - row.startedAt < START_GRACE_MS;
  // A claim with no session behind it is a window that started a row and then went away
  // (or a start that never finished); once the grace is over the row is up for grabs again.
  if (!row.startedAt || (!row.sessionId && !fresh)) return row.needsFolder ? 'needsFolder' : 'queued';
  if (!ev.alive) return fresh ? 'working' : 'ended';
  const s = tabStateBadgeState(ev.live, ev.file);
  if (s === 'input') return 'asking';
  if (s === 'ended') return ev.seen ? 'seen' : 'finished';
  if (s === 'working') return 'working';
  return fresh && !ev.file ? 'working' : 'seen';
}

function sortRows(rows, states) {
  return rows.slice().sort((a, b) =>
    (STATE_RANK[states.get(a.gid)] - STATE_RANK[states.get(b.gid)]) || (a.order - b.order));
}

// The rows to start now, in queue order: as many `queued` ones as there are free slots.
// needsFolder and failed rows are never started by themselves and never hold a slot.
function nextToStart(rows, states, cap = MAX_WORKING) {
  const working = rows.filter((r) => states.get(r.gid) === 'working').length;
  return rows.filter((r) => states.get(r.gid) === 'queued')
    .sort((a, b) => a.order - b.order)
    .slice(0, Math.max(0, cap - working));
}

// Whether a window may claim this row to start it: nobody has, or somebody did and never
// got a session running within the grace period.
function isClaimable(row, now) {
  return !row.failed && !row.needsFolder
    && (!row.startedAt || (!row.sessionId && now - row.startedAt >= START_GRACE_MS));
}

// A task with a row that is not dead already has its session (or is waiting for one);
// launching it again would run two Claudes on one task. A dead row is replaced, so a
// task that ended can be queued again — its folder holds a session, which resumes.
// Returns the new rows list and which gids were added or skipped.
function mergeTasks(rows, tasks, states, now = Date.now()) {
  const out = rows.slice();
  const added = [], skipped = [];
  let order = rows.reduce((m, r) => Math.max(m, r.order), 0);
  for (const t of tasks) {
    const i = out.findIndex((r) => r.gid === t.gid);
    if (i >= 0 && !['ended', 'failed'].includes(states.get(t.gid))) { skipped.push(t.gid); continue; }
    if (i >= 0) out.splice(i, 1);
    out.push(newRow(t, ++order, now));
    added.push(t.gid);
  }
  return { rows: out, added, skipped };
}

// The part of an Asana task that folder resolution and the prompt read, and nothing else.
function slimTask(t) {
  return {
    gid: String(t.gid), name: t.name, permalink_url: t.permalink_url, homeless: !!t.homeless,
    projects: taskProjects(t).map((p) => ({ gid: p.gid, name: p.name })),
  };
}

function newRow(t, order, now) {
  return {
    gid: String(t.gid), name: String(t.name || '').replace(/^[\s✨]+/u, ''),
    permalink: t.permalink_url || `https://app.asana.com/0/0/${t.gid}`,
    task: slimTask(t), order, queuedAt: now, startedAt: null,
    folder: null, sessionId: null, socket: null, tabId: null, target: null, needsFolder: false, failed: null, claimedBy: null,
  };
}

// ─── the store ───────────────────────────────────────────────────────────────

// Run fn while holding the file's lock, so two windows never interleave a read-modify-write.
// A lock older than ten seconds belongs to a window that died holding it.
function withLock(lock, fn) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { /* just released */ }
      if (age > 10000 || Date.now() - t0 > 5000) { try { fs.unlinkSync(lock); } catch {} continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}

// The row list, backed by one JSON file shared by every window. Reads are cheap and repeat
// only when the file changed (refresh); every change goes through update(), which re-reads
// under the lock, applies the change and writes atomically, so a window holding an old copy
// can never drop another window's rows.
class QueueStore {
  constructor(file) { this.file = file; this.rows = []; this._stamp = null; this.refresh(true); }
  _stat() { try { const s = fs.statSync(this.file); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; } }
  // True when the rows were re-read. A file that cannot be parsed leaves the old rows alone.
  refresh(force) {
    const stamp = this._stat();
    if (!force && stamp === this._stamp) return false;
    let rows = [];
    if (stamp) { try { rows = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return false; } }
    this.rows = Array.isArray(rows) ? rows : [];
    this._stamp = stamp;
    return true;
  }
  // fn edits the fresh rows in place, or returns a new list to replace them.
  update(fn) {
    withLock(this.file + '.lock', () => {
      this.refresh(true);
      const out = fn(this.rows);
      if (Array.isArray(out)) this.rows = out;
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.rows));
      fs.renameSync(tmp, this.file);
      this._stamp = this._stat();
    });
  }
  find(gid) { return this.rows.find((r) => r.gid === gid); }
}

// Claim a row to start it. The check and the write happen under the lock, and a second
// look confirms that the claim is still ours, so of two windows only one gets to start it.
function claimRow(st, gid, windowId, now = Date.now()) {
  let won = false;
  st.update((rows) => {
    const r = rows.find((x) => x.gid === gid);
    if (r && isClaimable(r, now)) { r.startedAt = now; r.claimedBy = windowId; won = true; }
  });
  if (!won) return false;
  st.refresh(true);
  const r = st.find(gid);
  return !!r && r.claimedBy === windowId;
}

// ─── reading the sessions ────────────────────────────────────────────────────

// Session ids with a live claude process, straight from the CLI's session files.
function liveSessionIds() {
  const ids = new Set();
  let files;
  try { files = fs.readdirSync(tabStateSessionsDir()); } catch { return ids; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(tabStateSessionsDir(), f), 'utf8')); } catch { continue; }
    if (s && s.sessionId && typeof s.pid === 'number' && tabStateProcAlive(s.pid, s.procStart)) ids.add(s.sessionId);
  }
  return ids;
}

function computeStates(rows, now = Date.now()) {
  const live = tabStateLive(), files = tabStateReadAll(), ids = liveSessionIds();
  const out = new Map();
  for (const r of rows) {
    const ev = {
      alive: !!r.startedAt && (ids.has(r.sessionId) || (!!r.tabId && live.has(r.tabId))),
      live: r.tabId ? live.get(r.tabId) : undefined,
      file: r.tabId ? files.get(r.tabId) : undefined,
      seen: !!r.tabId && tabStateSeen.has(r.tabId),
    };
    out.set(r.gid, rowState(r, ev, now));
  }
  return out;
}

// ─── the view ────────────────────────────────────────────────────────────────

let store = null;              // set by initQueue
let hooks = { start: null, pickFolder: null };   // set by newtask.js, which owns folder resolution
const queueTerminals = new Map();   // gid -> the terminal attached to that row's session
let provider = null;
let pumping = false;
let lastSignature = '';

class QueueProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
    this.view = null;   // set after createTreeView so the count badge can go on it
  }
  refresh() { this._em.fire(); this._badge(); }
  _badge() {
    if (!this.view || !store) return;
    const states = computeStates(store.rows);
    const n = store.rows.filter((r) => ['asking', 'finished'].includes(states.get(r.gid))).length;
    try { this.view.badge = n ? { value: n, tooltip: `${n} session${n === 1 ? '' : 's'} need you` } : undefined; } catch {}
  }
  getTreeItem(row) {
    const state = computeStates([row]).get(row.gid);
    const item = new vscode.TreeItem(row.name, vscode.TreeItemCollapsibleState.None);
    item.description = [STATE_WORD[state], row.folder ? path.basename(row.folder) : ''].filter(Boolean).join(' · ');
    const [icon, color] = STATE_ICON[state];
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.tooltip = [row.name, row.folder, STATE_WORD[state], row.failed, row.sessionId].filter(Boolean).join('\n');
    item.contextValue = 'queueRow' + (state === 'ended' || state === 'failed' ? 'Ended' : row.startedAt ? 'Live' : 'Waiting');
    item.command = { command: 'claudeHelper.openQueueSession', title: 'Open Session', arguments: [row] };
    return item;
  }
  getChildren() {
    if (!store) return [];
    return sortRows(store.rows, computeStates(store.rows));
  }
}

// Something about the rows changed (already written to the file): repaint, and see
// whether a slot freed.
function changed() {
  if (!store) return;
  if (provider) provider.refresh();
  pump();
}

// Same reach as Kill Session in Agent Sessions: the id is in both the master's socket path
// and claude's arguments; then drop the socket file.
function killSession(sessionId) {
  try { cp.spawnSync('pkill', ['-f', sessionId]); } catch {}
  try { fs.unlinkSync(path.join(dtachSocketDir(), sessionId + '.sock')); } catch {}
  removeDtachLog(sessionId);   // the scrollback log goes with the socket
}

async function startRow(row) {
  // Claimed in the shared file: counts as working, in every window, while the folder resolves.
  if (!claimRow(store, row.gid, WINDOW_ID)) return;
  if (provider) provider.refresh();
  let res;
  try { res = await hooks.start(row); } catch (e) { res = { error: e.message }; }
  let mine = false;
  store.update((rows) => {
    const r = rows.find((x) => x.gid === row.gid);
    if (!r || r.claimedBy !== WINDOW_ID) return;
    mine = true;
    if (!res || res.needsFolder) Object.assign(r, { startedAt: null, claimedBy: null, needsFolder: true });
    else if (res.error) Object.assign(r, { startedAt: null, claimedBy: null, failed: res.error });
    else Object.assign(r, { startedAt: Date.now(), needsFolder: false, folder: res.folder, sessionId: res.sessionId, socket: res.socket, tabId: res.tabId });
  });
  // The row was removed (or the claim lost) while the session was starting. The session
  // has done nothing yet, so it is killed rather than left running with no row — unless
  // it is one that was already running before we got there, or the row now names it.
  if (!mine && res && res.sessionId && !res.reused) {
    const cur = store.find(row.gid);
    if (!cur || cur.sessionId !== res.sessionId) killSession(res.sessionId);
  }
  if (provider) provider.refresh();
}

// Start whatever the free slots allow. Sequential, and never re-entered: a folder
// resolution can take seconds, and the tick that calls this fires every two.
async function pump() {
  if (pumping || !store || !hooks.start) return;
  pumping = true;
  try {
    // Again until nothing is left to start: a row that turned out to need a folder (or
    // failed) gives its slot straight back, and the next queued task should take it now,
    // not on the next tick. Every pass takes at least one row out of `queued`, so it ends.
    // (A row another window won the claim for is `working` by then, so it ends there too.)
    const pending = () => { store.refresh(); return nextToStart(store.rows, computeStates(store.rows)); };
    for (let next = pending(); next.length; next = pending()) {
      for (const row of next) await startRow(row);
    }
  } finally { pumping = false; }
}

// Called from the tab-state refresh: pick up other windows' changes, repaint only when a
// row's state moved, and let the scheduler see whether one left `working`.
function tick() {
  if (!store) return;
  store.refresh();
  const states = computeStates(store.rows);
  const sig = store.rows.map((r) => `${r.gid}:${states.get(r.gid)}`).join(',');
  if (sig !== lastSignature) { lastSignature = sig; if (provider) provider.refresh(); }
  pump();
}

// Rows for the ticked tasks; a task whose session is still alive keeps its row.
// Returns how many rows were added.
function addTasks(tasks) {
  if (!store) return 0;
  let added = [];
  store.update((rows) => {
    const m = mergeTasks(rows, tasks, computeStates(rows));
    added = m.added;
    return m.rows;
  });
  changed();
  // Show where they went: the rows are the only trace of a session with no tab.
  try { vscode.commands.executeCommand('claudeHelper.queue.focus'); } catch {}
  return added.length;
}

function setQueueHooks(h) { hooks = { ...hooks, ...h }; }

// ─── row actions ─────────────────────────────────────────────────────────────

async function openQueueSession(row) {
  row = row && store && store.find(row.gid);   // the live row, not the one the tree was painted with
  if (!row) return;
  const state = computeStates([row]).get(row.gid);
  if (state === 'needsFolder' || state === 'failed') {
    // A click on a row that could not be placed is how Pat answers the question the
    // queue deliberately did not ask: pick the folder now, and it starts when a slot is free.
    const target = state === 'failed' ? row.target : hooks.pickFolder && await hooks.pickFolder(row);
    if (state === 'needsFolder' && !target) return;
    store.update((rows) => {
      const r = rows.find((x) => x.gid === row.gid);
      if (r) Object.assign(r, { target, needsFolder: false, failed: null });
    });
    changed();
    return;
  }
  if (state === 'queued') {
    vscode.window.showInformationMessage(`"${row.name}" is waiting for a free slot (at most ${MAX_WORKING} sessions work at once).`);
    return;
  }
  if (!row.socket || !sessionDtachSocket(row.sessionId)) {
    vscode.window.showInformationMessage(`"${row.name}" has ended — resume it from Recent Sessions.`);
    return;
  }
  const shown = queueTerminals.get(row.gid);
  if (shown && vscode.window.terminals.includes(shown) && !shown.exitStatus) { shown.show(); return; }
  // Named like every other picked-task tab. The socket is on the command line, which is
  // how the tab badge finds its session even where the tab id is not registered.
  const name = `📌 ${path.basename(row.folder)}`;
  const terminal = vscode.window.createTerminal({ name, cwd: fs.existsSync(row.folder) ? row.folder : undefined, iconPath: launchIcon(true) });
  terminal.show();
  moveTerminalTabToEnd();
  terminal.sendText(` ${dtachEnterCmd(row.socket)}`);
  queueTerminals.set(row.gid, terminal);
  registerSessionTerminal(row.sessionId, terminal);
  // The master was started by us with this id in its env, so the mapping is exact —
  // and it is what makes the badge work on a terminal attached long after the launch.
  if (row.tabId) { registerTabState(terminal, row.tabId); rememberTabName(row.tabId, name); tabStateSeen.add(row.tabId); }
}

function openQueueTask(row) { if (row) openAsanaTask({ permalink: row.permalink }); }

// The tab attached to a row's session, if this window has one: the one opened from the
// row, or (after a reload, when that is forgotten) the one whose tab id is the row's.
function rowTerminal(row) {
  const shown = queueTerminals.get(row.gid);
  if (shown && vscode.window.terminals.includes(shown)) return shown;
  return row.tabId ? vscode.window.terminals.find((t) => tabStateKeyForTerminal(t) === row.tabId) : undefined;
}

async function removeQueueRow(row) {
  row = row && store && store.find(row.gid);
  if (!row) return;
  const state = computeStates([row]).get(row.gid);
  let kill = false;
  if (row.sessionId && !['ended', 'failed'].includes(state)) {
    const KEEP = 'Remove, keep it running', KILL = 'Remove and kill it';
    const pick = await vscode.window.showWarningMessage(
      `"${row.name}" still has a live session.`, { modal: true, detail: 'Removing the row does not stop it unless you say so.' }, KEEP, KILL);
    if (!pick) return;
    kill = pick === KILL;
  }
  // A row that goes together with its session takes its tab along; a session that is
  // kept running keeps its tab. Looked up before the kill: the lookup reads the live process.
  const terminal = kill || ['ended', 'failed'].includes(state) ? rowTerminal(row) : undefined;
  if (kill && row.sessionId) killSession(row.sessionId);
  if (terminal) terminal.dispose();
  queueTerminals.delete(row.gid);
  store.update((rows) => rows.filter((r) => r.gid !== row.gid));
  changed();
}

// Closing a row's tab by hand ends the row with it, but only when its session sits idle
// after a finished turn: that one is done for now and can be resumed from Recent Sessions.
// A session that is working or asking keeps running and keeps its row — there, closing
// the tab just means "out of my way".
const endsWithTab = (state) => state === 'finished' || state === 'seen';

// Only a close by the user counts. onDidCloseTerminal also fires while the extension host
// tears down on a window reload (see tabStateTerminalClosed), and ending every finished
// session on a reload is exactly what must not happen.
function queueTerminalClosed(terminal) {
  if (!store) return;
  const hit = [...queueTerminals].find(([, t]) => t === terminal);
  if (!hit) return;
  queueTerminals.delete(hit[0]);
  if (!terminal.exitStatus || terminal.exitStatus.reason !== vscode.TerminalExitReason.User) return;
  const row = store.find(hit[0]);
  if (!row || !endsWithTab(computeStates([row]).get(row.gid))) return;
  if (row.sessionId) killSession(row.sessionId);
  store.update((rows) => rows.filter((r) => r.gid !== row.gid));
  changed();
}

// After a reload the row -> tab map is empty while the tabs are still there. One pass,
// once the terminals have settled, finds them again by the tab id each row carries.
function relinkTerminals() {
  if (!store) return;
  for (const t of vscode.window.terminals) {
    const key = tabStateKeyForTerminal(t);
    const row = key && store.rows.find((r) => r.tabId === key);
    if (row && !queueTerminals.has(row.gid)) queueTerminals.set(row.gid, t);
  }
}

function clearFinishedQueue() {
  if (!store) return;
  store.update((rows) => {
    const states = computeStates(rows);
    const gone = rows.filter((r) => ['ended', 'failed'].includes(states.get(r.gid)));
    for (const r of gone) { const t = rowTerminal(r); if (t) t.dispose(); queueTerminals.delete(r.gid); }
    return rows.filter((r) => !gone.includes(r));
  });
  changed();
}

// Open the shared file and hook into the tab-state refresh events. Rows that were queued
// when the window closed start again from the first tick — in whichever window claims them.
function initQueue() {
  store = new QueueStore(queueFile());
  provider = new QueueProvider();
  onTabStateTick(tick);
  setTimeout(pump, 3000);
  setTimeout(relinkTerminals, 8000);
  return provider;
}

module.exports = {
  MAX_WORKING, START_GRACE_MS, STATE_RANK, rowState, sortRows, nextToStart, mergeTasks, slimTask, newRow, isClaimable, claimRow, queueFile,
  QueueStore, computeStates, QueueProvider, addTasks, setQueueHooks, openQueueSession, openQueueTask,
  removeQueueRow, clearFinishedQueue, endsWithTab, queueTerminalClosed, initQueue, tick, pump,
};
