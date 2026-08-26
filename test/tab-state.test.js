#!/usr/bin/env node
// Tests the tab-state badge end to end: the real code out of extension.js, real
// state files, real /proc — only VS Code itself is stubbed.
//
// The badge is a chain of guesses about a session (which tab is it, is it
// running, did anyone read it) and every link of it has been wrong at least
// once, so this drives the actual provider rather than a paraphrase of it.
// Sessions are real sleeping child processes carrying a real CCH_TAB_ID, so
// /proc/<pid>/environ and the procStart check are exercised for real.
//
// Run: node test/tab-state.test.js
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), cp = require('child_process');

// ─── the stub VS Code sees ───────────────────────────────────────────────────
const listeners = { openTerminal: [], closeTerminal: [], activeTerminal: [] };
let decorationProvider = null;
const fired = [];
const vscode = {
  ThemeColor: class { constructor(id) { this.id = id; } },
  EventEmitter: class {
    constructor() { this.handlers = []; this.event = (h) => { this.handlers.push(h); return { dispose() {} }; }; }
    fire(v) { fired.push(v); for (const h of this.handlers) h(v); }
  },
  Uri: { parse: (s) => ({ scheme: s.split(':')[0], path: s.slice(s.indexOf(':') + 1), toString: () => s }) },
  window: {
    terminals: [],
    activeTerminal: undefined,
    state: { focused: true },
    registerFileDecorationProvider(p) { decorationProvider = p; return { dispose() {} }; },
    onDidChangeActiveTerminal(h) { listeners.activeTerminal.push(h); return { dispose() {} }; },
  },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) },
};
const settings = { tabStateDecorations: true, tabStateTrace: false };

// ─── the real code ───────────────────────────────────────────────────────────
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-test-'));
fs.mkdirSync(path.join(HOME, '.cache', 'claude-tab-state'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude', 'dtach'), { recursive: true });
const osStub = Object.assign(Object.create(os), { homedir: () => HOME });

const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const from = src.indexOf('let tabStateTerminalCounter = 0;');
const to = src.indexOf('// ─── recent sessions');
if (from < 0 || to < 0) { console.error('could not find the tab-state block in extension.js'); process.exit(2); }
const block = src.slice(from, to);
const load = new Function('vscode', 'fs', 'path', 'os', 'crypto', 'cfg', `${block}
  return { TabStateDecorationProvider, tabStateSeedTerminals, tabStateTerminalOpened, tabStateTerminalFocused,
           tabStateRefresh, tabStateBadgeState, tabStateReadSessions, tabStateKeyForTerminal,
           setProvider: (p) => { tabStateProvider = p; }, seen: tabStateSeen };`);
const T = load(vscode, fs, path, osStub, crypto, () => vscode.workspace.getConfiguration());

// ─── fixtures ────────────────────────────────────────────────────────────────
const children = [];
// A session is TWO real processes, the way it is on the box: the terminal's own
// shell, which is what VS Code hands us a pid for and which outlives the
// session, and the claude process the session file names. Both carry the same
// CCH_TAB_ID, since the second inherits it from the first.
function spawnWith(tabId, cwd) {
  const child = cp.spawn('sleep', ['120'], { cwd, env: { ...process.env, CCH_TAB_ID: tabId }, stdio: 'ignore' });
  children.push(child);
  return child.pid;
}
function stripTabId(env) { const e = { ...env }; delete e.CCH_TAB_ID; return e; }
function startSession(status, cwd) {
  const tabId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  fs.mkdirSync(cwd, { recursive: true });
  const shellPid = spawnWith(tabId, cwd);
  const pid = spawnWith(tabId, cwd);
  writeSession(pid, { pid, cwd, procStart: procStartOf(pid), status, sessionId, kind: 'interactive' });
  return { tabId, pid, shellPid, cwd, sessionId };
}
function writeSession(pid, obj) {
  fs.writeFileSync(path.join(HOME, '.claude', 'sessions', `${pid}.json`), JSON.stringify(obj));
}
function setStatus(s, status) { writeSession(s.pid, { pid: s.pid, cwd: s.cwd, procStart: procStartOf(s.pid), status, kind: 'interactive' }); }
function procStartOf(pid) { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' ')[19]; }
function hook(tabId, word) { fs.writeFileSync(path.join(HOME, '.cache', 'claude-tab-state', tabId), word); }

let terminalCount = 0;
function addTerminal(pid, name) {                        // what VS Code hands the extension
  const t = { name, processId: Promise.resolve(pid) };
  vscode.window.terminals.push(t);
  T.tabStateTerminalOpened(t);
  return { terminal: t, uri: vscode.Uri.parse(`vscode-terminal://w/${++terminalCount}`) };
}

// ─── assertions ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function badge(tab) {
  const d = decorationProvider.provideFileDecoration(tab.uri);
  return d ? d.badge : null;
}
function is(actual, expected, what) {
  const ok = actual === expected;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}

(async () => {
  decorationProvider = new T.TabStateDecorationProvider();
  T.setProvider(decorationProvider);

  const busy   = startSession('busy',  path.join(HOME, 'busy'));
  const shell  = startSession('shell', path.join(HOME, 'shell'));
  const idle   = startSession('idle',  path.join(HOME, 'idle'));
  const asking = startSession('idle',  path.join(HOME, 'asking'));
  await new Promise((r) => setTimeout(r, 50));            // let processId promises settle

  const tBusy   = addTerminal(busy.shellPid, 'busy');
  const tShell  = addTerminal(shell.shellPid, 'shell');
  const tIdle   = addTerminal(idle.shellPid, 'idle');
  const tAsking = addTerminal(asking.shellPid, 'asking');
  await new Promise((r) => setTimeout(r, 50));

  console.log('\nlive state beats a stale hook file');
  hook(busy.tabId, 'ended');                              // the stale badge 0.35.0 was aimed at
  is(badge(tBusy), '*', 'a running turn shows the dot even when the file says the turn ended');
  hook(shell.tabId, 'ended');
  is(badge(tShell), '*', 'a session parked in a background shell shows the dot');
  hook(idle.tabId, 'working');                            // stale: the session died mid-turn
  is(badge(tIdle), null, 'a live idle session clears a stale working file');

  console.log('\nthe hook file decides why a stopped session stopped');
  hook(asking.tabId, 'input');
  is(badge(tAsking), '?', 'idle + a real prompt is a question mark, not silence');
  hook(idle.tabId, 'ended');
  is(badge(tIdle), '!', 'a finished turn nobody has read is an exclamation mark');

  console.log('\nreading it clears the mark');
  T.tabStateRefresh();                                    // the tick that notices `ended`
  T.tabStateTerminalFocused(tIdle.terminal);
  is(badge(tIdle), null, 'focusing the tab drops the exclamation mark');
  is(fired.length > 0, true, 'focusing re-queries that tab, so the badge actually disappears');
  vscode.window.activeTerminal = tIdle.terminal;
  is(badge(tIdle), null, 'the tab you are sitting on never carries one');

  console.log('\na new turn is unread again');
  setStatus(idle, 'busy'); hook(idle.tabId, 'working'); T.tabStateRefresh();
  vscode.window.activeTerminal = undefined;
  is(badge(tIdle), '*', 'it goes back to working');
  setStatus(idle, 'idle'); hook(idle.tabId, 'ended'); T.tabStateRefresh();
  is(badge(tIdle), '!', 'the next finished turn is unread even though you read the last one');

  console.log('\nidentity');
  const dead = startSession('busy', path.join(HOME, 'dead'));
  const deadTab = addTerminal(dead.shellPid, 'dead');
  await new Promise((r) => setTimeout(r, 50));
  hook(dead.tabId, 'ended');
  process.kill(dead.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 100));
  is(T.tabStateReadSessions().has(dead.tabId), false, 'a session file whose process is gone is ignored');
  writeSession(dead.pid, { pid: dead.pid, cwd: dead.cwd, procStart: '999999999', status: 'busy', kind: 'interactive' });
  is(T.tabStateReadSessions().has(dead.tabId), false, 'a recycled pid cannot inherit a dead session (procStart)');
  is(badge(deadTab), '!', 'its tab falls back to what the hook last wrote, the terminal being alive');

  console.log('\na REATTACHED session, whose terminal carries no CCH_TAB_ID');
  // The real shape of a resumed session: the terminal's shell has no tab id of
  // its own and only a `dtach -a <session-id>.sock` child to go on, while the
  // claude process it attached to has carried the tab id since it was launched.
  const resumed = startSession('busy', path.join(HOME, 'resumed'));
  const sock = path.join(HOME, '.claude', 'dtach', `${resumed.sessionId}.sock`);
  const attachShell = cp.spawn('bash', ['-c', `(exec -a "dtach -a ${sock}" sleep 120) & wait`],
    { cwd: resumed.cwd, env: stripTabId(process.env), stdio: 'ignore' });
  children.push(attachShell);
  await new Promise((r) => setTimeout(r, 150));            // let bash fork the child
  const tResumed = addTerminal(attachShell.pid, 'resumed');
  await new Promise((r) => setTimeout(r, 50));
  is(T.tabStateKeyForTerminal(tResumed.terminal), resumed.tabId, 'the tab id is found through the dtach socket');
  hook(resumed.tabId, 'ended');
  // The live read is memoised for a second, so a session that appeared inside
  // that second is not in it yet; the 2s tick invalidates. Doing it by hand here
  // asserts the steady state rather than the one-tick transient.
  T.tabStateRefresh();
  is(badge(tResumed), '*', 'so a resumed session that is working shows the dot');
  setStatus(resumed, 'idle'); T.tabStateRefresh();
  is(badge(tResumed), '!', 'and its finished turn is marked, instead of nothing at all');

  console.log('\nthe words themselves');
  for (const [live, file, want, what] of [
    ['working', 'ended',   'working', 'live working over ended'],
    ['working', 'input',   'working', 'live working over a question'],
    ['idle',    'input',   'input',   'live idle never eats a question'],
    ['idle',    'ended',   'ended',   'live idle never eats an unread turn'],
    ['idle',    'working', 'idle',    'live idle clears stale work'],
    [undefined, 'ended',   'ended',   'no live opinion: the file decides'],
    ['input',   'ended',   'input',   'a live prompt outranks the file'],
  ]) is(T.tabStateBadgeState(live, file), want, what);

  for (const c of children) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
