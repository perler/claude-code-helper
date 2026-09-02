const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { cfg } = require('./shared');
// ─── tab state decorations ───────────────────────────────────────────────────
//
// Shows, on a Claude session's terminal editor tab, whether it is working,
// waiting for an answer, or idle — via VS Code's file-decoration API, without
// touching the tab's title or icon. See readme.md "Tab state decorations".
//
// A terminal editor tab is identified only by a `vscode-terminal:/<workspaceId>/
// <instanceId>` URI (its fragment, where a launch would normally carry the
// session name, is always empty — VS Code builds the resource before the name is
// applied). The public API never exposes instanceId directly, so it is tracked
// by counting terminals in creation order ourselves and trusting that order to
// match VS Code's internal one: seed from the terminals already open at
// activation (covers a window-reload restore, verified to land in the same
// order), then increment on every onDidOpenTerminal. instanceIds are never
// reused within a window, so closed entries are dropped, not renumbered.
//
// A terminal survives a code-server window reload as the SAME live OS process —
// VS Code just reconnects its pty, the launcher functions above never run again —
// so after a reload nothing here has been re-registered for it. registerTabState()
// below is therefore only a same-window fast path, not the source of truth: the
// decoration provider falls back to reading the terminal's own live process's
// environment (`/proc/<pid>/environ`), which still carries whatever CCH_TAB_ID
// VS Code set on it at creation, unaffected by the reload. This recovers a real
// id wherever the terminal's own shell IS (or directly forked) the process
// running Claude — the plain internal-terminal launcher, and dtach mode, whose
// attach terminal's shell is the very process `dtach -n` forked the master
// from. tmux mode's attach terminal is a different process from the tmux
// server that forked Claude, so it never has anything to read and stays
// undecorated regardless (known limitation, see readme.md).
let tabStateTerminalCounter = 0;

const tabStateTerminalsById = new Map();  // instanceId -> vscode.Terminal

const tabStateIdByTerminal = new Map();   // vscode.Terminal -> CCH_TAB_ID uuid (this window minted it)

const tabStatePidByTerminal = new Map();  // vscode.Terminal -> pid, once terminal.processId resolves

const tabStateEnvIdCache = new Map();     // vscode.Terminal -> CCH_TAB_ID uuid | null, read from /proc once

const tabStateUriByInstanceId = new Map();// instanceId -> the vscode-terminal: URI VS Code asked us about

const tabStateKeyByTerminal = new Map();  // vscode.Terminal -> state-file key last resolved for it (or null)

let tabStateLastStates = new Map();       // state-file name -> its content, as of the last refresh

let tabStateProvider;

function tabStateDecorationsEnabled() { return cfg().get('tabStateDecorations') !== false; }

function tabStateDir() { return path.join(os.homedir(), '.cache', 'claude-tab-state'); }

// terminal.processId is a Thenable<number|undefined> — VS Code hasn't necessarily
// resolved it yet when a terminal first appears, so this is fire-and-forget; a
// decoration query that lands before it resolves just tries again next time
// (tabStateIdFromEnviron only caches once a pid is actually on file).
function tabStateResolvePid(t) {
  if (!t || !t.processId) return;
  t.processId.then(
    (pid) => { if (typeof pid === 'number') tabStatePidByTerminal.set(t, pid); },
    () => {}
  );
}

function tabStateSeedTerminals() {
  for (const t of vscode.window.terminals) { tabStateTerminalsById.set(++tabStateTerminalCounter, t); tabStateResolvePid(t); }
}

function tabStateTerminalOpened(t) { tabStateTerminalsById.set(++tabStateTerminalCounter, t); tabStateResolvePid(t); }

function tabStateTerminalClosed(t) {
  for (const [instanceId, term] of tabStateTerminalsById) {
    if (term !== t) continue;
    tabStateTerminalsById.delete(instanceId);
    tabStateUriByInstanceId.delete(instanceId);
    break;
  }
  tabStateKeyByTerminal.delete(t);
  tabStatePidByTerminal.delete(t);
  tabStateEnvIdCache.delete(t);
  tabStateDtachIdCache.delete(t);
  tabStateIdByTerminal.delete(t);
  // Deliberately NOT deleting the state file here. onDidCloseTerminal also fires
  // while the extension host tears down on a window reload, and at that moment a
  // dtach-backed session is very much alive — deleting then wipes exactly the
  // "waiting for your answer" flag the user reloaded to get back to (verified:
  // the badge vanished after a reload while claude was still running). The
  // authoritative end-of-life signal is the SessionEnd hook's `delete`; a session
  // killed hard enough to skip it is cleaned up by the sweep below.
}

// Drop state files whose CCH_TAB_ID no longer belongs to any live process. Runs
// once, a few seconds after activation, so a hard-killed session cannot leave a
// badge behind for the next terminal that happens to reuse the instance id.
function tabStateSweepStale() {
  let files;
  try { files = fs.readdirSync(tabStateDir()); } catch { return; }
  if (!files.length) return;
  const live = new Set();
  let pids;
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return; }
  for (const pid of pids) {
    try {
      for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) {
        if (entry.startsWith('CCH_TAB_ID=')) { live.add(entry.slice('CCH_TAB_ID='.length)); break; }
      }
    } catch { /* process gone or not ours */ }
    // cwd- keys belong to a directory, not a process id, so a directory that
    // still has any live process of ours in it keeps its state file.
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      live.add('cwd-' + crypto.createHash('sha1').update(cwd).digest('hex'));
    } catch { /* not ours */ }
  }
  for (const f of files) {
    if (live.has(f)) continue;
    try { fs.unlinkSync(path.join(tabStateDir(), f)); } catch {}
  }
}

// Called once a createTerminal() call has actually put CCH_TAB_ID=tabId into a
// Claude session's environment — never for a terminal that only attaches to a
// session started (or already running) some other way.
function registerTabState(terminal, tabId) {
  tabStateIdByTerminal.set(terminal, tabId);
}

// CCH_TAB_ID read back from the terminal's own live process, for a terminal this
// window never registered itself (typically: restored after a window reload).
// /proc/<pid>/environ is NUL-separated KEY=VALUE with no trailing NUL guaranteed,
// hence the split rather than a line-based read. Cached per terminal — once the
// pid is known, the answer can't change for that process's lifetime — except while
// the pid is still unresolved, when null is returned but NOT cached, so the next
// query (the debounced watcher fires often) retries instead of getting stuck.
function tabStateIdFromEnviron(terminal) {
  if (tabStateEnvIdCache.has(terminal)) return tabStateEnvIdCache.get(terminal);
  const pid = tabStatePidByTerminal.get(terminal);
  if (!pid) return null;
  let result = null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'latin1');
    for (const entry of raw.split('\0')) {
      if (!entry.startsWith('CCH_TAB_ID=')) continue;
      const v = entry.slice('CCH_TAB_ID='.length);
      if (/^[0-9a-f-]{36}$/.test(v)) result = v;
      break;
    }
  } catch { /* pid gone, or /proc unreadable — no decoration, same as an unknown id */ }
  tabStateEnvIdCache.set(terminal, result);
  return result;
}

// Fallback identity for sessions that were already running before CCH_TAB_ID
// existed: their environment is fixed and can never gain one, so key on the
// working directory instead, which the hook also writes (see hooks/tab-state.sh).
// Only trusted when exactly ONE tracked terminal sits in that directory — with
// two sessions in one folder the key cannot say which tab is which, and a badge
// on the wrong tab is worse than none.
function tabStateTerminalCwd(terminal) {
  const pid = tabStatePidByTerminal.get(terminal);
  if (!pid) return null;
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

function tabStateCwdKey(terminal) {
  const cwd = tabStateTerminalCwd(terminal);
  if (!cwd) return null;
  let seen = 0;
  for (const t of tabStateTerminalsById.values()) {
    if (tabStateTerminalCwd(t) === cwd && ++seen > 1) return null;
  }
  return 'cwd-' + crypto.createHash('sha1').update(cwd).digest('hex');
}

// ─── the live state, read straight from the CLI's own session files ─────────
//
// The hook files are event-driven: each records what was true at the instant an
// event fired, and nothing happens between events. So a session that ends a
// turn, gets the 60-second "Claude is waiting for your input" nudge and then
// goes back to work — or, worse, sits in a long `run_in_background` shell with
// no tool calls at all — keeps whatever that nudge wrote. Observed live
// 2026-08-26: a session waiting on a background job showed "?" for minutes with
// nothing being asked, because PreToolUse (the self-heal) had nothing to fire
// on.
//
// `~/.claude/sessions/<pid>.json` is where the CLI itself keeps that answer —
// one small JSON per running session with its pid, cwd, procStart and a live
// `status` (idle / busy / shell / …), and it is what `claude agents --json`
// reports from. Reading it directly costs a readdir plus a few tiny reads, so
// it can happen on the decoration path; shelling out to the CLI measured ~470ms
// and therefore had to be polled into a cache asynchronously. That cache was
// its own bug: a tab painted from the hook file before the first answer landed
// kept that badge until the COMPUTED state changed again, which for a session
// parked in a background job never happens. 0.35.0 shipped that; this replaces
// it.
//
// If the directory or the format ever goes away, every read here returns
// nothing and the hook files run the badges on their own, as they did before.
const tabStateTabIdByPid = new Map();  // pid -> CCH_TAB_ID | null (a process's environ never changes)

let tabStateLiveCache = new Map();     // state-file key -> 'working' | 'input' | 'idle'

let tabStateLiveCacheAt = 0;

function tabStateSessionsDir() { return path.join(os.homedir(), '.claude', 'sessions'); }

// The CLI's vocabulary collapsed onto the three words a badge renders. `idle` is
// the only word that means "doing nothing"; everything else it reports — `busy`,
// `shell`, and whatever a later version adds — is the session doing something,
// which is exactly what the dot is for. A waiting/blocked word is treated as a
// question so a future upstream state lands on '?' rather than on silence.
function tabStateWordForSessionStatus(s) {
  if (typeof s !== 'string' || !s) return null;
  if (s === 'idle') return 'idle';
  if (/wait|block|input|permission|approval|prompt/i.test(s)) return 'input';
  return 'working';
}

// Whether that pid is still the process the session file was written for.
// procStart is field 22 of /proc/<pid>/stat, so a recycled pid can never
// inherit a dead session's badge. The `)` split keeps a comm with spaces in it
// from shifting the columns.
function tabStateProcAlive(pid, procStart) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return false; }
  if (!procStart) return true;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19] === String(procStart);
}

// The tab id of a running session, read off the claude process itself.
function tabStateTabIdForPid(pid) {
  if (typeof pid !== 'number') return null;
  if (tabStateTabIdByPid.has(pid)) return tabStateTabIdByPid.get(pid);
  let result = null;
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) {
      if (!entry.startsWith('CCH_TAB_ID=')) continue;
      const v = entry.slice('CCH_TAB_ID='.length);
      if (/^[0-9a-f-]{36}$/.test(v)) result = v;
      break;
    }
  } catch { /* pid gone, or not ours — same as a session with no CCH_TAB_ID */ }
  tabStateTabIdByPid.set(pid, result);
  return result;
}

// One pass over the session files, keyed the same way the hook writes.
function tabStateReadSessions() {
  const out = new Map();
  const byCwd = new Map();   // cwd -> words, to spot the ambiguous case below
  const seenPids = new Set();
  let files;
  try { files = fs.readdirSync(tabStateSessionsDir()); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(tabStateSessionsDir(), f), 'utf8')); } catch { continue; }
    if (!s || typeof s.pid !== 'number' || !tabStateProcAlive(s.pid, s.procStart)) continue;
    seenPids.add(s.pid);
    const word = tabStateWordForSessionStatus(s.status);
    const tabId = word ? tabStateTabIdForPid(s.pid) : null;
    if (tabId) out.set(tabId, word);
    // Every live session counts towards the cwd census, including ones we have
    // no word for — a second session in the folder makes the key ambiguous
    // whatever state it is in.
    if (s.cwd) byCwd.set(s.cwd, (byCwd.get(s.cwd) || []).concat(word));
  }
  for (const pid of [...tabStateTabIdByPid.keys()]) if (!seenPids.has(pid)) tabStateTabIdByPid.delete(pid);
  // A cwd key is an identity only while exactly ONE session lives in that
  // directory; with two it cannot say which one a tab is showing. Same rule
  // tabStateCwdKey() applies from the terminal side.
  for (const [cwd, words] of byCwd) {
    if (words.length !== 1 || !words[0]) continue;
    out.set('cwd-' + crypto.createHash('sha1').update(cwd).digest('hex'), words[0]);
  }
  return out;
}

// Memoised for a second, because VS Code asks the provider once per visible tab
// and a burst of those should read the directory once, not fifteen times.
function tabStateLive() {
  const now = Date.now();
  if (now - tabStateLiveCacheAt >= 1000) {
    tabStateLiveCacheAt = now;
    tabStateLiveCache = tabStateReadSessions();
  }
  return tabStateLiveCache;
}

// What a tab actually renders, from the two sources that each know half of it.
//
// The session file knows, at any moment, whether the session is DOING something
// — which the event-driven hook files cannot. The hook files know why a session
// stopped: `ended` is a finished turn, `input` is a real prompt. So a live
// `working` wins over whatever the file last wrote, and a live `idle` clears a
// stale `working` — but it must NEVER clear `ended` or `input`, which are the
// two states a stopped session can be in and the only ones the CLI cannot tell
// apart (it reports both as plain `idle`). Letting it do that is what emptied
// the tab bar in 0.35.0.
function tabStateBadgeState(live, file) {
  if (!live) return file;                        // no live opinion on this key — the file decides
  if (live === 'working' || live === 'input') return live;
  return (file === 'input' || file === 'ended') ? file : live;   // live === 'idle'
}

// ─── which finished turns you have already looked at ────────────────────────
//
// `ended` means the turn is over and nobody has read it. That is worth a badge
// exactly until you look, so the mark is cleared by FOCUS, which is the one
// part of this only the extension can see: the tab you are sitting on is being
// read by definition, and the moment you leave it, anything the session does
// afterwards is unread again.
//
// Deliberately not persisted. After a window reload every finished turn is
// unread again, which is the safe direction — a badge you have already dealt
// with costs a glance, a missing one costs the session.
const tabStateSeen = new Set();   // state-file key -> you have looked since it ended

// The active terminal is being read right now, so it stays marked as seen for as
// long as it is focused — otherwise a turn that ends while you watch it would
// put a '!' on the very tab you are looking at. Only while the WINDOW has focus:
// with the editor in the background, whatever finishes is genuinely unread.
function tabStateMarkActiveSeen() {
  if (!vscode.window.state.focused) return;
  const t = vscode.window.activeTerminal;
  if (!t) return;
  const key = tabStateKeyForTerminal(t);
  if (key) tabStateSeen.add(key);
}

// Focusing a tab has to re-query that tab: its state word has not changed, so
// the ordinary diff in tabStateRefresh() would fire nothing and the '!' would
// stay on screen until something else moved.
function tabStateTerminalFocused(t) {
  if (!t) return;
  const key = tabStateKeyForTerminal(t);
  if (!key || tabStateSeen.has(key)) return;
  tabStateSeen.add(key);
  for (const [instanceId, term] of tabStateTerminalsById) {
    if (term !== t) continue;
    const uri = tabStateUriByInstanceId.get(instanceId);
    if (uri && tabStateProvider) tabStateProvider.fireFor([uri]);
    break;
  }
}

// Opt-in trace of what every tab computed, for diagnosing a badge that looks
// wrong: `"claudeHelper.tabStateTrace": true` writes ~/.cache/claude-tab-state.exttrace.
// Read live, so it can be turned on and off without reloading the window.
function tabStateTrace(line) {
  if (!cfg().get('tabStateTrace')) return;
  try {
    fs.appendFileSync(path.join(os.homedir(), '.cache', 'claude-tab-state.exttrace'),
      new Date().toISOString().slice(11, 23) + ' ' + line + '\n');
  } catch { /* tracing must never break a decoration */ }
}

// ─── a reattached session's terminal ────────────────────────────────────────
//
// A terminal that ATTACHES to a session which was already running gets no
// CCH_TAB_ID: the session is already carrying the one it was born with, and
// planting a second, fresh one in the attach terminal would just be an id
// nothing ever writes to. So neither of the two routes above finds anything,
// and the cwd fallback is refused whenever more than one session lives in the
// folder — which is how a resumed session ends up permanently undecorated. That
// is the tab Pat was watching all afternoon.
//
// What the attach client does carry is the session's socket path,
// ~/.claude/dtach/<session-id>.sock, on its command line. And the CLI's session
// file names the pid that IS that session, whose environ has the real tab id.
// So: terminal -> its dtach child -> session id -> live pid -> CCH_TAB_ID.
const tabStateDtachIdCache = new Map();   // vscode.Terminal -> CCH_TAB_ID | null

// The session id off the `dtach -a` client running inside this terminal.
function tabStateDtachSessionId(pid) {
  let kids;
  // /proc/<pid>/task/<pid>/children is a space-separated pid list. Absent on a
  // kernel built without CONFIG_PROC_CHILDREN, in which case this route simply
  // has no answer and the cwd fallback takes over, as before.
  try { kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/); } catch { return null; }
  for (const kid of kids) {
    if (!kid) continue;
    let cmd;
    try { cmd = fs.readFileSync(`/proc/${kid}/cmdline`, 'latin1'); } catch { continue; }
    if (!cmd.includes('dtach')) continue;
    const m = /([0-9a-f-]{36})\.sock/.exec(cmd);
    if (m) return m[1];
  }
  return null;
}

// That session id's live pid, from the CLI's own session files.
function tabStatePidForSessionId(sessionId) {
  let files;
  try { files = fs.readdirSync(tabStateSessionsDir()); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(tabStateSessionsDir(), f), 'utf8')); } catch { continue; }
    if (s && s.sessionId === sessionId && typeof s.pid === 'number' && tabStateProcAlive(s.pid, s.procStart)) return s.pid;
  }
  return null;
}

function tabStateIdFromDtach(terminal) {
  if (tabStateDtachIdCache.has(terminal)) return tabStateDtachIdCache.get(terminal);
  const pid = tabStatePidByTerminal.get(terminal);
  if (!pid) return null;                       // not resolved yet — retry next time, don't cache
  const sessionId = tabStateDtachSessionId(pid);
  const result = sessionId ? tabStateTabIdForPid(tabStatePidForSessionId(sessionId)) : null;
  // Only cached once there was something to find: a session still starting up
  // has no session file yet, and that must not harden into "this tab has no id".
  if (result) tabStateDtachIdCache.set(terminal, result);
  return result;
}

// The one place that decides which state file belongs to a terminal, so the
// provider and the refresh below can never disagree about it.
function tabStateKeyForTerminal(terminal) {
  return tabStateIdByTerminal.get(terminal) || tabStateIdFromEnviron(terminal)
      || tabStateIdFromDtach(terminal) || tabStateCwdKey(terminal) || null;
}

class TabStateDecorationProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._em.event;
  }
  // Named URIs only — NEVER fire(undefined). See tabStateRefresh() for why.
  fireFor(uris) { this._em.fire(uris); }
  provideFileDecoration(uri) {
    if (!tabStateDecorationsEnabled() || uri.scheme !== 'vscode-terminal') return undefined;
    const m = /\/(\d+)$/.exec(uri.path);
    if (!m) return undefined;
    // Remember the exact URI VS Code uses for this tab: a targeted re-query can
    // only name URIs, and there is no public API to build one.
    tabStateUriByInstanceId.set(Number(m[1]), uri);
    const terminal = tabStateTerminalsById.get(Number(m[1]));
    if (!terminal) { tabStateTrace(`decorate ${uri.path} -> no terminal for instance ${m[1]}`); return undefined; }
    const tabId = tabStateKeyForTerminal(terminal);
    if (!tabId) { tabStateTrace(`decorate ${uri.path} name=${terminal.name} -> no key`); return undefined; }
    let file;
    try { file = fs.readFileSync(path.join(tabStateDir(), tabId), 'utf8').trim(); } catch { /* no file yet */ }
    const live = tabStateLive().get(tabId);
    let state = tabStateBadgeState(live, file);
    // A finished turn you have already looked at renders nothing at all.
    if (state === 'ended' && (tabStateSeen.has(tabId) || terminal === vscode.window.activeTerminal)) state = 'read';
    tabStateTrace(`decorate ${uri.path} name=${terminal.name} key=${tabId.slice(0, 8)} live=${live || '-'} file=${file || '-'} -> ${state || 'none'}`);
    if (state === 'input') return { badge: '?', color: new vscode.ThemeColor('list.warningForeground'), tooltip: 'Claude is asking you something' };
    if (state === 'working') return { badge: '*', color: new vscode.ThemeColor('list.deemphasizedForeground'), tooltip: 'Claude is working' };
    if (state === 'ended') return { badge: '!', color: new vscode.ThemeColor('list.warningForeground'), tooltip: 'Claude finished — you have not looked yet' };
    return undefined; // idle, read, or a value we don't render — no decoration
  }
}

// Every key's EFFECTIVE state — the same combination the provider renders, and
// therefore the only thing worth diffing for a re-query.
// activate() calls this instead of constructing the provider itself: the module-level
// `tabStateProvider` is what tabStateRefresh() fires through, so it has to be set here.
function createTabStateProvider() {
  tabStateProvider = new TabStateDecorationProvider();
  return tabStateProvider;
}

function tabStateEffectiveAll() {
  const files = tabStateReadAll();
  const out = new Map(files);
  for (const [k, v] of tabStateReadSessions()) out.set(k, tabStateBadgeState(v, files.get(k)));
  return out;
}

// Read the state directory as name -> state word. Contents, not mtimes: the
// PreToolUse hook rewrites `working` over `working` on every single tool call,
// so mtime changes constantly while nothing a tab renders has changed.
function tabStateReadAll() {
  const dir = tabStateDir();
  const out = new Map();
  let files;
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    try { out.set(f, fs.readFileSync(path.join(dir, f), 'utf8').trim()); } catch { /* vanished mid-read */ }
  }
  return out;
}

// Re-query only the tabs whose state actually changed.
//
// 🚨 Do not go back to firing `undefined` ("re-query everything"). VS Code
// answers that by DELETING every cached decoration and immediately emitting a
// change for all of them; the re-query then goes to the extension host over
// RPC, which is asynchronous, so every tab renders one frame with no badge
// before the answer arrives. With a hook write landing on most tool calls of
// every running session, that read as the whole tab bar flickering several
// times a second (reported live 2026-08-26, with a screen recording). A fire
// naming specific URIs takes a different path in VS Code: it refetches first
// and only emits once the value is in, so the tab changes without blanking.
//
// Cheap enough to run on every event: a readdir plus a read of a handful of
// tiny files, and it fires nothing at all when no state word moved.
let tabStateWatchDebounce;

function tabStateRefresh() {
  if (!tabStateProvider) return;
  tabStateLiveCacheAt = 0;   // the tick that diffs is the tick that refreshes the live read
  const now = tabStateEffectiveAll();
  const changed = new Set();
  for (const [k, v] of now) {
    if (tabStateLastStates.get(k) === v) continue;
    // A turn that just ended is unread by definition, even on a tab you read a
    // moment ago — that is the whole point of clearing the mark by focus.
    if (v === 'ended') tabStateSeen.delete(k);
    changed.add(k);
  }
  tabStateMarkActiveSeen();
  for (const k of tabStateLastStates.keys()) if (!now.has(k)) changed.add(k);
  tabStateLastStates = now;

  const uris = new Map();
  for (const [instanceId, term] of tabStateTerminalsById) {
    const key = tabStateKeyForTerminal(term);
    const prev = tabStateKeyByTerminal.get(term);
    // Either this tab's state word moved, or the tab only just became
    // identifiable (its pid resolved, a sibling in the same cwd closed).
    const affected = prev !== key || (key && changed.has(key));
    tabStateKeyByTerminal.set(term, key);
    if (!affected) continue;
    const uri = tabStateUriByInstanceId.get(instanceId);
    // No URI yet means VS Code has never asked about this tab, so it has no
    // decoration to correct — it will ask when it first renders.
    if (uri) uris.set(uri.toString(), uri);
  }
  if (changed.size || uris.size) tabStateTrace(`refresh changed=${[...changed].map((k) => k.slice(0, 8)).join(',') || '-'} fire=${uris.size}`);
  if (uris.size) tabStateProvider.fireFor([...uris.values()]);
}

// Debounced so a burst of hook writes (a busy session flipping working/idle/working)
// triggers one re-query, not one per file event.
function tabStateChanged() {
  clearTimeout(tabStateWatchDebounce);
  tabStateWatchDebounce = setTimeout(tabStateRefresh, 150);
}

// Required: without a change event, an already-open tab is never re-queried after
// its first render, however many times the hook rewrites its state file.
function startTabStateWatcher(context) {
  const dir = tabStateDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, () => tabStateChanged());
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch { /* dir unwritable — badges just never appear */ }

  // fs.watch alone is not enough: observed live, a session's file went input ->
  // working while its tab kept showing the stale "?" for hours, because no change
  // event ever reached the provider. A badge that lies is worse than no badge, so
  // poll the directory as well. tabStateRefresh() compares state words and fires
  // nothing when none moved, so a tick that finds no change costs a readdir plus
  // a read of a handful of tiny files.
  const poll = setInterval(tabStateChanged, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
}

// ─── recent sessions ─────────────────────────────────────────────────────────

// ─── end tab state ───────────────────────────────────────────────────────────
// test/tab-state.test.js slices everything above this line out of the file and runs
// it against real state files and real processes. Keep the marker.

module.exports = {
  tabStateTerminalsById, tabStateIdByTerminal, tabStatePidByTerminal,
  tabStateEnvIdCache, tabStateUriByInstanceId, tabStateKeyByTerminal, tabStateDecorationsEnabled, tabStateDir, tabStateResolvePid,
  tabStateSeedTerminals, tabStateTerminalOpened, tabStateTerminalClosed, tabStateSweepStale,
  registerTabState, tabStateIdFromEnviron, tabStateTerminalCwd, tabStateCwdKey,
  tabStateTabIdByPid, tabStateSessionsDir,
  tabStateWordForSessionStatus, tabStateProcAlive, tabStateTabIdForPid, tabStateReadSessions,
  tabStateLive, tabStateBadgeState, tabStateSeen, tabStateMarkActiveSeen, tabStateTerminalFocused,
  tabStateTrace, tabStateDtachIdCache, tabStateDtachSessionId, tabStatePidForSessionId,
  tabStateIdFromDtach, tabStateKeyForTerminal, TabStateDecorationProvider, tabStateEffectiveAll,
  tabStateReadAll, createTabStateProvider, tabStateRefresh, tabStateChanged, startTabStateWatcher,
};
