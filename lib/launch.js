const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');

const { agentSocket, readAgentIndex, tmuxHasSession, writeAgentIndex } = require('./agent-index');
const { checkFavExists } = require('./favourites');
const { providers } = require('./providers');
const { liveSessionIds, registerSessionTerminal, sessionDtachSocket } = require('./session-registry');
const {
  DATE_NAME_RE, cfg, dtachSocketDir, encodeProjectDir, expandHome, listSessions, oneLine, readSessionMeta, relativeTime, shortHome, shq, slugifyTitle, snippet, timestampName, useDtach, useTmux,
} = require('./shared');
const { registerTabState, tabStateKeyForTerminal } = require('./tabstate');
const { findReusableTerminal } = require('./terminals');
function buildClaudeCommand(resumeArg, initialPrompt) {
  const c = cfg();
  const cmd = c.get('claudeCommand') || 'claude';
  const parts = [cmd];
  if (c.get('skipPermissions')) parts.push('--dangerously-skip-permissions');
  if (resumeArg === true) parts.push('-c');
  else if (typeof resumeArg === 'string' && resumeArg) parts.push('--resume', resumeArg);
  const extra = (c.get('cliFlags') || '').trim();
  if (extra) parts.push(extra);
  // `claude [options] [prompt]` — a positional prompt starts an interactive
  // session with that message already submitted. Must stay last.
  if (initialPrompt) parts.push(shq(initialPrompt));
  return parts.join(' ');
}

// Pre-fill the session-name prompt with something derived from the launch dir.
// Sessions under ~/clients/<CODE>/… get a "CODE/folder" prefix so it's clear
// which client they belong to (just "CODE" when launched at the client root);
// everything else (projects, tasks, …) uses the bare folder name.
function defaultSessionName(dir) {
  if (!dir) return '';
  const base = path.basename(dir);
  const segs = dir.split(path.sep).filter(Boolean);
  const ci = segs.indexOf('clients');
  if (ci !== -1 && ci < segs.length - 1) {
    const code = segs[ci + 1];
    return base === code ? code : `${code}/${base}`;
  }
  return base;
}

// Prompt for a session name on every new-session launch. Pre-filled from the
// launch dir (see defaultSessionName); empty → timestamp.
// Returns the chosen name, or null if the user cancelled (Esc).
async function promptSessionName(dir) {
  const name = defaultSessionName(dir);
  const value = name + ' ';
  const input = await vscode.window.showInputBox({
    title: 'Start Claude Session',
    prompt: 'Name this session (leave blank for a timestamp).',
    placeHolder: 'e.g. billing-bug — or leave empty for a timestamp',
    value,
    // Collapsed selection at the end → nothing highlighted, cursor behind the space.
    valueSelection: [value.length, value.length],
  });
  if (input === undefined) return null; // cancelled
  return input.trim() || timestampName();
}

async function pickTerminalMode() {
  const mode = cfg().get('defaultTerminalMode') || 'internal';
  if (mode !== 'ask') return mode;
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(terminal) Integrated terminal', value: 'internal' },
      { label: '$(window) External terminal', value: 'external' },
    ],
    { placeHolder: 'Where should Claude run?' }
  );
  return pick ? pick.value : null;
}

// Tab icon that distinguishes a new session from a resumed one (no text — the
// project name comes from the cwd). resumeArg falsy = new, truthy = resume.
function launchIcon(resumeArg) {
  return new vscode.ThemeIcon(resumeArg ? 'history' : 'sparkle');
}

// With terminal.integrated.defaultLocation=editor a new terminal opens as an editor
// tab, and VS Code inserts it next to the active one (workbench.editor.openPositioning
// defaults to "right") — so a launch lands in the middle of the tab strip. Push it to
// the far right instead.
//
// Only ever moves a tab that IS a terminal: when the terminal opened in the panel the
// active tab is still whatever file the user was editing, and moving that would shuffle
// their editors. show() activates the tab asynchronously, hence the short poll.
async function moveTerminalTabToEnd() {
  for (let i = 0; i < 20; i++) {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    if (tab && tab.input instanceof vscode.TabInputTerminal) {
      if (group.tabs.indexOf(tab) < group.tabs.length - 1)
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'last', by: 'tab' });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function runInInternalTerminal(name, cwd, cmd, icon) {
  let terminal;
  if (cfg().get('reuseTerminal')) terminal = findReusableTerminal(cwd);
  const created = !terminal;
  // Claude runs directly in this terminal's own shell, so CCH_TAB_ID on its env
  // reaches the process unconditionally — unlike the tmux/dtach launchers, there's
  // no separate master to thread it through.
  const tabId = crypto.randomUUID();
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd, iconPath: icon, env: { CCH_TAB_ID: tabId } });
  terminal.show();
  if (created) { moveTerminalTabToEnd(); registerTabState(terminal, tabId); rememberTabName(tabId, name); }
  terminal.sendText(cmd);
  return terminal;
}

function runInExternalTerminal(cwd, cmd) {
  const template = (cfg().get('externalTerminalCommand') || '').trim();
  let spawnCmd;
  if (template) {
    spawnCmd = template.replace(/\{cwd\}/g, cwd).replace(/\{cmd\}/g, cmd);
  } else {
    const candidates = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
    const has = (b) => {
      try { cp.execSync(`command -v ${b}`, { stdio: 'ignore' }); return true; } catch { return false; }
    };
    const term = candidates.find(has);
    if (!term) {
      vscode.window.showErrorMessage('Claude Code Helper: no external terminal found. Set claudeHelper.externalTerminalCommand.');
      return;
    }
    spawnCmd = `${term} -e bash -c 'cd ${JSON.stringify(cwd)} && ${cmd}; exec bash'`;
  }
  cp.exec(spawnCmd, (err) => { if (err) vscode.window.showErrorMessage(`Claude Code Helper: ${err.message}`); });
}

// dtdrain — the lossy-drain relay piped after `dtach -a`. code-server's pty host
// pauses the pty after 100 000 unacknowledged bytes (terminal flow control); on a
// half-open/silently-dropped websocket the browser stops acking, the pty pauses,
// the full pty blocks `dtach -a`'s stdout, which blocks the dtach master in
// select(), which blocks Claude's stdout and trips its ~120 s stall watchdog
// ("Response stalled mid-stream"). dtdrain writes to the terminal non-blocking and
// drops on a wedged pty, so the master is always drained and Claude keeps running.
// Built once from the shipped dtdrain.c into the socket dir; null (-> plain attach,
// the pre-relay behaviour) if no C compiler is available or the build fails.
let _dtdrainBin; // undefined = not yet tried, null = unavailable, string = path

function dtdrainBin() {
  if (_dtdrainBin !== undefined) return _dtdrainBin;
  _dtdrainBin = null;
  try {
    const src = path.join(__dirname, '..', 'dtdrain.c');
    if (!fs.existsSync(src)) return _dtdrainBin;
    const outDir = dtachSocketDir();
    fs.mkdirSync(outDir, { recursive: true });
    const bin = path.join(outDir, 'dtdrain');
    const fresh = fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs;
    if (!fresh) {
      const cc = ['cc', 'gcc', 'clang'].find((c) => { try { return cp.spawnSync(c, ['--version']).status === 0; } catch { return false; } });
      if (!cc) return _dtdrainBin;
      const r = cp.spawnSync(cc, ['-O2', '-o', bin, src]);
      if (r.status !== 0 || !fs.existsSync(bin)) return _dtdrainBin;
    }
    _dtdrainBin = bin;
  } catch { _dtdrainBin = null; }
  return _dtdrainBin;
}

// Session masters (the tmux server / dtach master that actually hold Claude) are
// launched into a dedicated user-manager cgroup slice (claude.slice) rather than
// inheriting code-server's own cgroup. That way a runaway session's memory hits
// claude.slice's limit instead of code-server@work.service's — so it can't OOM
// the editor and disconnect the user (which is exactly what happened 2026-06-23).
// Reaching the user manager from a code-server (system-service) context needs
// XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS, which those terminals lack — so we
// inject them. Falls back to a direct, unwrapped launch when the user systemd
// manager isn't reachable (no /run/user/<uid>/bus), e.g. non-systemd hosts.
function userBusReachable() {
  try { return process.getuid && fs.existsSync(`/run/user/${process.getuid()}/bus`); }
  catch { return false; }
}

function sessionSliceEnv() {
  const uid = process.getuid();
  return { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
}

// Per-scope bounds, so ONE session's runaway can't wedge the whole fleet.
// claude.slice's own MemoryHigh only bounds the *aggregate*: on 2026-07-13 a single
// ugrep (Claude's Grep tool) hit 11.4G scanning a .jsonl, pushed the slice past
// MemoryHigh, and the kernel then throttled EVERY session in it into D-state via
// mem_cgroup_handle_over_high — CPU idle, RAM fine, all sessions hung, and because
// the balloon sat between MemoryHigh(14G) and MemoryMax(18G) it was throttled forever
// and never OOM-killed. Capping each scope means the runaway dies in its own session.
// OOMPolicy=continue is essential: the scope default is `stop`, which makes systemd
// tear down the whole session when the kernel OOM-kills a child inside it — with
// `continue`, the kernel reaps just the runaway (memory.oom.group=0) and Claude lives.
// OOMPolicy can only be set at scope CREATION, not via `systemctl set-property`.
const SCOPE_LIMITS = ['-p', 'MemoryMax=6G', '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=continue'];

// Shell-string prefix to run a command inside claude.slice (for terminal.sendText).
function sliceWrapShell() {
  if (!userBusReachable()) return '';
  const uid = process.getuid();
  return `XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus ` +
    `systemd-run --user --scope --slice=claude.slice ${SCOPE_LIMITS.join(' ')} --quiet `;
}

function uniqueAgentTmuxName(dir) {
  const home = os.homedir();
  const rel = dir.startsWith(home) ? dir.slice(home.length) : dir;
  const base = ('claude' + rel).replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 48);
  let name = base, n = 1;
  const idx = readAgentIndex();
  while (tmuxHasSession(name) || idx.some((e) => e.tmuxName === name)) name = base.slice(0, 44) + '-' + (++n);
  return name;
}

// {id, runArg[]} for a launch: resume given id, continue -> most-recent id, else new id
function resolveSessionId(dir, resumeArg) {
  if (typeof resumeArg === 'string' && resumeArg) return { id: resumeArg, runArg: ['--resume', resumeArg] };
  if (resumeArg === true) { const r = listSessions(dir)[0]; if (r) return { id: r.id, runArg: ['--resume', r.id] }; }
  const id = crypto.randomUUID();
  return { id, runArg: ['--session-id', id] };
}

function launchClaudeTmux(fav, resumeArg, initialPrompt) {
  const dir = fav.path;
  const c = cfg();
  const bin = c.get('claudeCommand') || 'claude';
  const { id, runArg } = resolveSessionId(dir, resumeArg);
  let entry = readAgentIndex().find((e) => e.sessionId === id);
  let tmuxName = entry && entry.tmuxName;
  // Only a freshly-spawned master's env can carry CCH_TAB_ID (see below) — the
  // attach terminal created further down never runs Claude itself in this mode.
  const isNewMaster = !tmuxName || !tmuxHasSession(tmuxName);
  const tabId = crypto.randomUUID();
  if (isNewMaster) {
    tmuxName = tmuxName || uniqueAgentTmuxName(dir);
    const parts = [bin];
    if (c.get('skipPermissions')) parts.push('--dangerously-skip-permissions');
    parts.push(...runArg);
    const extra = (c.get('cliFlags') || '').trim(); if (extra) parts.push(extra);
    if (initialPrompt) parts.push(shq(initialPrompt));
    const cmd = parts.join(' ');
    const runner = path.join(dir, '.run-claude.sh');
    try {
      fs.writeFileSync(runner,
        `#!/usr/bin/env bash\ncd ${JSON.stringify(dir)}\n${cmd}\necho\necho "[claude session ended — resume with: ${bin} --resume ${id} --dangerously-skip-permissions]"\nexec bash\n`,
        { mode: 0o755 });
    } catch (e) { vscode.window.showErrorMessage(`Claude Code Helper: ${e.message}`); return; }
    // Start the (shared) tmux server inside claude.slice so the session it holds
    // lives outside code-server's cgroup. Only the first session starts the server;
    // later new-sessions just reach the existing one, so its slice is set once.
    const tmuxArgs = ['-L', agentSocket(), 'new-session', '-d', '-s', tmuxName, '-c', dir, `bash ${runner}`];
    // CCH_TAB_ID rides in here (not on the attach terminal's env below) because
    // this is the process that actually forks Claude — the attach terminal only
    // ever runs `tmux attach`.
    try {
      if (userBusReachable())
        cp.execFileSync('systemd-run', ['--user', '--scope', '--slice=claude.slice', ...SCOPE_LIMITS, '--quiet', 'tmux', ...tmuxArgs], { env: { ...sessionSliceEnv(), CCH_TAB_ID: tabId } });
      else
        cp.execFileSync('tmux', tmuxArgs, { env: { ...process.env, CCH_TAB_ID: tabId } });
    } catch (e) { vscode.window.showErrorMessage(`Claude Code Helper: tmux launch failed — ${e.message}`); return; }
    cp.spawnSync('tmux', ['-L', agentSocket(), 'kill-session', '-t', '0']);
    cp.spawnSync('tmux', ['-L', agentSocket(), 'set-option', '-g', 'mouse', 'off']);
    cp.spawnSync('tmux', ['-L', agentSocket(), 'set-option', '-g', 'status', 'off']);
    const sessions = readAgentIndex().filter((e) => e.sessionId !== id && e.tmuxName !== tmuxName);
    sessions.push({ sessionId: id, tmuxName, dir, displayName: fav.label || path.basename(dir), source: 'helper', createdAt: new Date().toISOString() });
    writeAgentIndex(sessions);
    if (providers.agent) { try { providers.agent.refresh(); } catch {} }
  }
  // name = bare folder/label so VS Code drops the duplicate ${cwdFolder} description.
  const name = fav.label || path.basename(dir);
  let terminal = cfg().get('reuseTerminal') ? findReusableTerminal(dir) : null;
  const created = !terminal;
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd: dir, iconPath: launchIcon(resumeArg) });
  terminal.show();
  if (created) moveTerminalTabToEnd();
  terminal.sendText(`tmux -L ${agentSocket()} attach -t ${tmuxName}`);
  registerSessionTerminal(id, terminal);
  // tmux mode never gets a decoration, new master or reattach alike: the attach
  // terminal above only ever runs `tmux attach` — it is a different OS process
  // from the tmux server that actually forked Claude, so there is no live
  // process whose /proc/<pid>/environ could tell us CCH_TAB_ID even when we
  // know it (unlike dtach, where the attach terminal's own shell IS the
  // process the master was forked from). Registering only on a fresh master
  // keeps the in-memory map honest, but reads it back through nothing durable —
  // known limitation, documented in readme.md "Tab state decorations".
  if (isNewMaster) { registerTabState(terminal, tabId); rememberTabName(tabId, fav.label); }
  return terminal;
}

// The attach half of a dtach launch, also used on its own to grab a session
// somebody else's master already runs (the Asana bridge's, say).
// -E: no detach escape char; -z: pass Ctrl-Z through; -r winch: redraw on attach.
// Piped through dtdrain (when available) so a flow-control-paused terminal can't
// back-pressure the master and stall Claude — see dtdrainBin(). dtach does its tty
// work on stdin, so piping stdout is safe.
function dtachAttachCmd(socket) {
  const relay = dtdrainBin();
  return `dtach -a ${JSON.stringify(socket)} -E -z -r winch` + (relay ? ` | ${JSON.stringify(relay)}` : '');
}

// Steal semantics: kill any attach client already on this socket before we attach,
// so grabbing a session from another window/machine moves it here instead of
// mirroring input into both (the old window's client drops back to its shell
// prompt; the master — and Claude — are untouched). A fresh launch has no clients
// yet, so the pkill is a no-op there. Must run before our own attach starts, so it
// can't kill it.
function dtachStealCmd(socket) {
  return `pkill -f ${JSON.stringify('dtach -a ' + socket)} 2>/dev/null`;
}

// The Asana bridge's `.run-claude.sh` carries environment a resumed session
// cannot work without: ASANA_TASK_GID, ASANA_CLAUDE_BRIDGE, the guard-flag and
// origin-flag paths, and the ~/.env token fallback. Rewriting the file with our
// own minimal runner used to strip all of it, so a session resumed from this
// extension lost its task identity, its guard posture, and the ability to post
// to Asana at all — every comment 401s on an empty Bearer.
//
// Only `export` lines are carried, and only from a directory the bridge owns
// (its marker file is there). Nothing is executed to read them.
function bridgeRunnerExports(dir, runner) {
  try {
    if (!fs.existsSync(path.join(dir, '.asana-claude.json'))) return '';
    const lines = fs.readFileSync(runner, 'utf8').split('\n')
      .filter((l) => /^export\s+[A-Z_][A-Z0-9_]*=/.test(l));
    return lines.length ? `${lines.join('\n')}\n` : '';
  } catch { return ''; }
}

function launchClaudeDtach(fav, resumeArg, initialPrompt) {
  const dir = fav.path;
  const c = cfg();
  const bin = c.get('claudeCommand') || 'claude';
  const { id, runArg } = resolveSessionId(dir, resumeArg);
  const parts = [bin];
  if (c.get('skipPermissions')) parts.push('--dangerously-skip-permissions');
  parts.push(...runArg);
  const extra = (c.get('cliFlags') || '').trim(); if (extra) parts.push(extra);
  if (initialPrompt) parts.push(shq(initialPrompt));
  const cmd = parts.join(' ');
  const runner = path.join(dir, '.run-claude.sh');
  // NEVER overwrite the Asana bridge's runner. Its version exports
  // ASANA_TASK_GID, ASANA_CLAUDE_BRIDGE, the guard-flag path, the origin flag
  // and the ~/.env token fallback; ours exports none of them, so replacing it
  // silently strips a resumed bridge session of its task identity, its guard
  // posture and its ability to post to Asana at all (every comment 401s).
  // Detected by the bridge's own marker file rather than by reading the script,
  // so a hand-edited runner in a task directory is still protected.
  //
  // Keeping the bridge's runner verbatim is NOT the fix: it pins one session id,
  // so resuming a different session from the same task directory would silently
  // reopen the wrong conversation. Carry its `export` lines onto our own command
  // instead — right session, right environment.
  const exports = bridgeRunnerExports(dir, runner);
  try {
    fs.writeFileSync(runner,
      `#!/usr/bin/env bash\ncd ${JSON.stringify(dir)}\n${exports}${cmd}\necho\necho "[claude session ended — resume with: ${bin} --resume ${id} --dangerously-skip-permissions]"\nexec bash\n`,
      { mode: 0o755 });
  } catch (e) { vscode.window.showErrorMessage(`Claude Code Helper: ${e.message}`); return; }
  let socket;
  try {
    const sockDir = dtachSocketDir();
    fs.mkdirSync(sockDir, { recursive: true });
    socket = path.join(sockDir, id + '.sock');
  } catch (e) { vscode.window.showErrorMessage(`Claude Code Helper: ${e.message}`); return; }
  // name = bare folder/label so VS Code drops the duplicate ${cwdFolder} description.
  const name = fav.label || path.basename(dir);
  // Whether a live master already answers this socket, checked before the `dtach -n`
  // below either forks a brand-new one — inheriting THIS terminal's shell's own env,
  // CCH_TAB_ID included, since `dtach -n` runs as its child — or silently no-ops
  // against an existing one whose env was fixed at its own, unrelated creation.
  // Only pass CCH_TAB_ID when we're genuinely creating the master: on a pure
  // reattach it would sit in this terminal's env unused (a fresh id nothing ever
  // writes to), never mistaken for real because it resolves to no state file, but
  // there's no reason to plant it either.
  const wasLive = !!sessionDtachSocket(id);
  const tabId = crypto.randomUUID();
  let terminal = cfg().get('reuseTerminal') ? findReusableTerminal(dir) : null;
  const created = !terminal;
  if (!terminal) {
    const opts = { name, cwd: dir, iconPath: launchIcon(resumeArg) };
    if (!wasLive) opts.env = { CCH_TAB_ID: tabId };
    terminal = vscode.window.createTerminal(opts);
  }
  terminal.show();
  if (created) moveTerminalTabToEnd();
  // Create the master detached (no controlling terminal), then attach a client.
  // This keeps the claude process's lifetime fully independent of this code-server
  // terminal — parity with the Asana bridge's `dtach -n` — instead of `dtach -A`,
  // which parents the master under the interactive client. `dtach -n` is a harmless
  // no-op (errors, swallowed) when the session is already live, so re-opening just
  // re-attaches and the trailing `dtach -a` always fires a fresh -r winch redraw.
  // Only the `dtach -n` master (which holds Claude) goes into claude.slice; the
  // trailing `dtach -a` attach client is a thin, short-lived terminal-side client
  // and is left in place. sliceWrapShell() is '' when the user manager is absent.
  // A leftover socket file also blocks the master from starting: `dtach -n` binds
  // the path and fails with EADDRINUSE if a file is sitting on it (verified — dtach
  // does not clean up after itself), the launch line's 2>/dev/null swallows that,
  // and the attach behind it reports "Connection refused". Harmless while the
  // session really is live (the -n is a deliberate no-op and we just re-attach),
  // fatal for resuming one whose master died: a resume keeps the session id, so it
  // keeps the socket path, so the master can never come back. Drop the file when
  // nothing is listening on it — which is also what the Asana bridge reads as dead.
  if (fs.existsSync(socket) && !sessionDtachSocket(id)) {
    try { fs.unlinkSync(socket); } catch { /* raced with a real master — leave it */ }
  }
  const sock = JSON.stringify(socket);
  const attach = dtachAttachCmd(socket);
  const steal = dtachStealCmd(socket);
  // Leading space keeps this internal launch line out of ~/.bash_history: bash's
  // ignorespace (set via HISTCONTROL=ignoreboth in the default .bashrc the interactive
  // terminal sources) drops space-prefixed commands from the history list. It's our
  // plumbing, not something the user typed, so it shouldn't clutter their history.
  terminal.sendText(` ${steal}; ${sliceWrapShell()}dtach -n ${sock} bash ${JSON.stringify(runner)} 2>/dev/null; ${attach}`);
  registerSessionTerminal(id, terminal);
  // Register ONLY when this terminal's env really carries tabId — i.e. when we
  // just created the master. On a reattach it was never planted (see the
  // opts.env gate above), and registering it anyway is NOT the harmless no-op
  // an earlier comment here claimed: the registration is the FIRST thing
  // tabStateKeyForTerminal() consults, so a dead id shadows the routes that
  // would have worked and the tab can never be decorated again. That is exactly
  // how a resumed session ended up with no badge at all. Left unregistered, it
  // resolves through the dtach route instead.
  if (!wasLive) { registerTabState(terminal, tabId); rememberTabName(tabId, fav.label); }
  return terminal;
}

// On a *silent* code-server reconnect (the browser/notebook drops and re-establishes
// its websocket) the dtach client stays attached the whole time, so no re-attach
// fires and `-r winch` never re-triggers — the full-screen Claude TUI shows stale
// output and looks frozen, even though the process is alive and well. Nudge every
// dtach master (a `dtach` process with no controlling tty) with SIGWINCH; the program
// repaints and dtach forwards the fresh frame to the reconnected client. SIGWINCH is
// benign — sessions that don't need it simply repaint.
//
// Two winches, spaced out. dtdrain drops the oldest bytes when its ring fills on a
// paused terminal (dtdrain.c), which can tear the escape-sequence stream mid-frame:
// lost cursor-move/clear sequences leave a stale frame (e.g. Claude's own welcome/
// fleet screen) overlaid on the live one, and a single differential winch-repaint
// won't rewrite the cells it thinks are already correct. The first winch fires now;
// the second fires after the drain ring has had time to flush, so the repaint lands
// on a settled grid and clears the overlay instead of interleaving with it.
function redrawDtachSessions() {
  const nudge = () => {
    try {
      cp.exec(`ps -e -o pid=,tty=,comm= | awk '$2=="?" && $3=="dtach"{print $1}' | xargs -r kill -WINCH`);
    } catch { /* best-effort redraw nudge */ }
  };
  nudge();
  setTimeout(nudge, 250);
}

// A launch name is "auto" (date-coded) when the user left the name blank and it fell
// back to timestampName() — the YYYY-MM-DD-HHMM shape. Those are the tabs worth renaming.
function isAutoName(label) {
  return typeof label === 'string' && DATE_NAME_RE.test(label.trim());
}

// ─── tab names across a window reload ────────────────────────────────────────
//
// A restored terminal comes back carrying only the FIRST WORD of its name. Measured
// on the 06:12 reload of 2026-09-04: "📅 inbox-zero · Today" came back as "📅" and
// "claude-code-helper tmp" as "claude-code-helper", while single-word names like
// "CloudBackups" survived whole. VS Code re-derives a reconnected terminal's title
// itself, and the name createTerminal() was given does not survive that, so the only
// way to keep it is to write it down and put it back.
//
// Keyed by the tab id the session already carries in its env (CCH_TAB_ID), because
// that is the one handle on a terminal that outlives the reload — the same one the
// tab-state badges resolve through.
function tabNamesFile() { return path.join(os.homedir(), '.cache', 'claude-code-helper', 'tab-names.json'); }

function readTabNames() {
  try { return JSON.parse(fs.readFileSync(tabNamesFile(), 'utf8')); } catch { return {}; }
}

function rememberTabName(tabId, name) {
  if (!tabId || !name) return;
  const all = readTabNames();
  all[tabId] = { name, at: Date.now() };
  // One entry per launch, so the file only ever grows. A tab id older than the
  // recent-sessions window has no terminal left to restore a name onto.
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(all)) if (!v || !(v.at > cutoff)) delete all[k];
  try {
    fs.mkdirSync(path.dirname(tabNamesFile()), { recursive: true });
    fs.writeFileSync(tabNamesFile(), JSON.stringify(all));
  } catch {}
}

// Put the full name back on every tab that came back truncated. Deliberately narrow:
// only when what survived is a leading word of what we recorded, so a tab renamed by
// hand keeps the hand-typed name.
async function repairTabNames() {
  const all = readTabNames();
  if (!Object.keys(all).length) return;
  for (const terminal of vscode.window.terminals) {
    if (terminal.exitStatus) continue;
    let key;
    try { key = tabStateKeyForTerminal(terminal); } catch { key = null; }
    const want = key && all[key] && all[key].name;
    if (!want || want === terminal.name) continue;
    if (!want.startsWith(`${terminal.name} `)) continue;
    await renameTerminalTab(terminal, want);
  }
}

// Rename a specific terminal's tab. renameWithArg targets the *active* terminal, so
// briefly make this one active (keeping keyboard focus in the editor), then restore.
async function renameTerminalTab(terminal, name) {
  if (!terminal || terminal.exitStatus) return;
  const label = name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!label) return;
  // Whatever a tab ends up called, that is the name to put back after a reload —
  // an ai-title rename included, which lands minutes after the launch name.
  try { rememberTabName(tabStateKeyForTerminal(terminal), label); } catch {}
  const prevActive = vscode.window.activeTerminal;
  terminal.show(true);
  try { await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: label }); } catch {}
  if (prevActive && prevActive !== terminal) { try { prevActive.show(true); } catch {} }
}

// Claude generates a short `ai-title` from the first prompt a few seconds after launch.
// Poll the transcript for it and rename the (date-coded) tab to it. Best-effort: the
// terminal may be closed, or the title may never arrive on a very short session — give
// up after ~50s either way.
function scheduleTabTitleRename(terminal, projectDir, launchTs, prefix) {
  let tries = 0;
  const timer = setInterval(() => {
    if (!terminal || terminal.exitStatus || ++tries > 20) { clearInterval(timer); return; }
    let title = null;
    try {
      for (const s of listSessions(projectDir)) { // newest first
        if (s.mtime < launchTs - 5000) break;      // predates this launch — not ours
        const m = readSessionMeta(s.file);
        if (m.aiTitle) { title = m.aiTitle; break; }
      }
    } catch {}
    if (title) { clearInterval(timer); renameTerminalTab(terminal, (prefix || '') + title); }
  }, 2500);
}

// ─── auto-rename date-coded scratch folders to their ai-title ────────────────────
//
// A rocket/scratch launch with no name given gets a timestamp folder (~/tasks/
// 2026-07-18-0747). Claude generates a short ai-title from the first prompt; once the
// session is no longer live, rename the folder (and its transcript project dir) to the
// title's slug so ~/tasks stays legible. This MUST NOT run on a live session: Claude
// caches its cwd string at startup and re-derives the transcript path from it per write,
// so renaming a running session's folder splits the transcript (verified). The sweep
// below only touches sessions with no running claude process.

function autoRenameEnabled() { return cfg().get('autoRenameScratchSessions') !== false; }

// Rewrite absolute + "parent/base" path references inside a (moved) project dir's
// transcripts from oldDir → newDir. Safe only when the session isn't live.
function rewriteTranscriptPaths(projDir, oldDir, newDir) {
  const oldRel = `${path.basename(path.dirname(oldDir))}/${path.basename(oldDir)}`;
  const newRel = `${path.basename(path.dirname(newDir))}/${path.basename(newDir)}`;
  let files; try { files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl')); } catch { return; }
  for (const f of files) {
    const p = path.join(projDir, f);
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const out = txt.split(oldDir).join(newDir).split(oldRel).join(newRel);
    if (out !== txt) { try { fs.writeFileSync(p, out); } catch {} }
  }
}

// Rename a finished scratch session's folder + transcript dir to the ai-title slug and
// rewrite the baked-in cwd so it stays resumable. Returns the new dir, or null.
function renameScratchSession(oldDir, aiTitle) {
  const slug = slugifyTitle(aiTitle);
  if (!slug || slug === path.basename(oldDir)) return null;
  const parent = path.dirname(oldDir);
  let newDir = path.join(parent, slug);
  if (fs.existsSync(newDir)) {
    let i = 2, cand;
    do { cand = path.join(parent, `${slug}-${i++}`); } while (fs.existsSync(cand));
    newDir = cand;
  }
  try { fs.renameSync(oldDir, newDir); } catch { return null; }
  const projRoot = path.join(os.homedir(), '.claude', 'projects');
  const oldProj = path.join(projRoot, encodeProjectDir(oldDir));
  const newProj = path.join(projRoot, encodeProjectDir(newDir));
  try {
    if (fs.existsSync(oldProj) && !fs.existsSync(newProj)) fs.renameSync(oldProj, newProj);
    rewriteTranscriptPaths(newProj, oldDir, newDir);
  } catch {}
  // Fix the launcher's `cd` line so re-running .run-claude.sh still works.
  try {
    const runner = path.join(newDir, '.run-claude.sh');
    const t = fs.readFileSync(runner, 'utf8');
    const u = t.split(oldDir).join(newDir);
    if (u !== t) fs.writeFileSync(runner, u, { mode: 0o755 });
  } catch {}
  // Deliberately NOT re-keyed: the ~/.claude.json `.projects[oldDir]` entry. For these
  // --dangerously-skip-permissions scratch sessions it's inert (empty trust/allowedTools/
  // mcpServers — only cosmetic usage stats), and that file is a global config every live
  // claude process rewrites, so a background read-modify-write here would race their
  // updates for no functional gain. The stale key is a harmless orphan; resume works via
  // the rewritten transcript cwd above.
  // Point any agent-index (tmux) entries at the new dir.
  try {
    const idx = readAgentIndex();
    let changed = false;
    for (const e of idx) if (e.dir === oldDir) {
      e.dir = newDir;
      if (e.displayName === path.basename(oldDir)) e.displayName = path.basename(newDir);
      changed = true;
    }
    if (changed) { writeAgentIndex(idx); if (providers.agent) { try { providers.agent.refresh(); } catch {} } }
  } catch {}
  return newDir;
}

// Find date-coded scratch folders whose session has ended and rename them to the
// ai-title slug. Runs periodically and on session-terminal close.
function sweepScratchRenames() {
  if (!autoRenameEnabled()) return;
  let scratchRoot;
  try { scratchRoot = expandHome(cfg().get('scratchDir') || '~/tasks'); } catch { return; }
  const encPrefix = encodeProjectDir(scratchRoot) + '-';
  const projRoot = path.join(os.homedir(), '.claude', 'projects');
  let dirs; try { dirs = fs.readdirSync(projRoot); } catch { return; }
  let live = null, renamedAny = false;
  for (const proj of dirs) {
    if (!proj.startsWith(encPrefix)) continue;
    const base = proj.slice(encPrefix.length);
    if (!DATE_NAME_RE.test(base)) continue;              // only unnamed date-coded folders
    const folder = path.join(scratchRoot, base);
    if (!fs.existsSync(folder)) continue;
    let files; try { files = fs.readdirSync(path.join(projRoot, proj)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    if (live === null) live = liveSessionIds();
    if (files.some((f) => live.has(f.slice(0, -'.jsonl'.length)))) continue;  // a session here is still running
    // Newest session's ai-title represents the folder.
    let best = null, bestT = -1;
    for (const f of files) {
      let m; try { m = readSessionMeta(path.join(projRoot, proj, f)); } catch { continue; }
      if (!m.aiTitle) continue;
      const t = m.lastTs ? Date.parse(m.lastTs) || 0 : 0;
      if (t >= bestT) { bestT = t; best = m.aiTitle; }
    }
    if (!best) continue;
    if (renameScratchSession(folder, best)) renamedAny = true;
  }
  if (renamedAny && providers.sess) { try { providers.sess.refresh(); } catch {} }
}

async function launchClaude(fav, resumeArg, opts = {}) {
  // Every new-session launch asks for a name first (timestamp if left blank).
  // Resumes keep the existing session, so they skip the prompt; newScratchSession
  // already prompts for its folder name and passes skipNamePrompt to avoid asking twice.
  if (resumeArg === false && !opts.skipNamePrompt) {
    const name = await promptSessionName(fav && fav.path);
    if (name === null) return; // cancelled
    fav = { ...fav, label: name };
  }
  // An icon in front of the session name (the New Task buttons put one there so a tab
  // says what it is about before the words are read). It rides separately from the label
  // rather than baked into it, because the date-coded test below reads the label — and a
  // prefixed timestamp is still an unnamed launch whose tab wants Claude's ai-title.
  const prefix = opts.namePrefix || '';
  const autoName = isAutoName(fav.label);
  if (prefix) fav = { ...fav, label: prefix + (fav.label || path.basename(fav.path)) };
  const mode = await pickTerminalMode();
  if (!mode) return;
  const prompt = opts.initialPrompt;
  let terminal;
  if (mode === 'internal' && useTmux()) terminal = launchClaudeTmux(fav, resumeArg, prompt);
  else if (mode === 'internal' && useDtach()) terminal = launchClaudeDtach(fav, resumeArg, prompt);
  else {
    const cmd = buildClaudeCommand(resumeArg, prompt);
    if (mode === 'external') runInExternalTerminal(fav.path, cmd);
    else terminal = runInInternalTerminal(fav.label || path.basename(fav.path), fav.path, cmd, launchIcon(resumeArg));
  }
  // Date-coded (unnamed) new launches show a timestamp in the tab; swap it for Claude's
  // generated ai-title once it lands in the transcript. Named launches keep their name.
  if (terminal && resumeArg === false && autoName) {
    scheduleTabTitleRename(terminal, fav.path, Date.now(), prefix);
  }
  // Running sessions are filtered out of Recent Sessions (liveSessionIds); nudge
  // the view shortly after launch so the row disappears now, not on the next 60s
  // tick. Staggered: tmux spawns claude near-instantly, but the dtach/plain paths
  // go through terminal.sendText and a shell startup, so the process can take a
  // few seconds to show up in ps.
  if (providers.sess) for (const ms of [2000, 8000]) setTimeout(() => { try { providers.sess.refresh(); } catch {} }, ms);
  // Truthy only when a session actually started — every early return above is a
  // user cancellation (name prompt, terminal-mode pick). The New Task box needs the
  // difference to decide whether taking focus back is helpful or destructive.
  // 'external' launches into another window and hand back no terminal object.
  return terminal || mode === 'external';
}

async function startClaude(fav) {
  if (!fav || !(await checkFavExists(fav))) return;
  await launchClaude(fav, false);
}

// Start a fresh, unscoped Claude session in a throwaway dir under scratchDir
// (~/tasks by default). The folder can be renamed/moved later with the
// refactor-workspace-paths skill once the work becomes permanent.
async function newScratchSession() {
  const label = await vscode.window.showInputBox({
    title: 'New Claude Session',
    prompt: 'Optional label (leave blank for a timestamp-only folder). You can rename it later.',
    placeHolder: 'e.g. billing-bug — or leave empty',
  });
  if (label === undefined) return; // cancelled
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const name = slug || timestampName();
  const base = expandHome(cfg().get('scratchDir') || '~/tasks');
  const dir = path.join(base, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Code Helper: could not create ${dir} — ${e.message}`);
    return;
  }
  await launchClaude({ path: dir, label: name }, false, { skipNamePrompt: true });
}

// ─── ask box ─────────────────────────────────────────────────────────────────

function favFromUri(uri) {
  const p = uri && uri.fsPath;
  if (!p) return null;
  return { path: p, label: path.basename(p) };
}

async function startClaudeFromUri(uri) {
  const fav = favFromUri(uri);
  if (!fav) { vscode.window.showWarningMessage('Claude Code Helper: no folder selected.'); return; }
  await startClaude(fav);
}

// Create a subfolder inside the right-clicked folder and start Claude in it
// straight away — the two-step "New Folder…" + "Start Claude Here" in one go.
async function newFolderAndStartClaudeFromUri(uri) {
  let base = uri && uri.fsPath;
  if (base) {
    try { if (!fs.statSync(base).isDirectory()) base = path.dirname(base); } catch { base = null; }
  }
  if (!base) base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!base) { vscode.window.showWarningMessage('Claude Code Helper: no folder selected.'); return; }
  const name = await vscode.window.showInputBox({
    title: 'New Folder & Start Claude',
    prompt: `Folder to create in ${shortHome(base)}`,
    placeHolder: 'e.g. billing-bug (nested paths allowed)',
    validateInput: (v) => {
      const t = (v || '').trim();
      if (!t) return 'Enter a folder name.';
      if (path.isAbsolute(t) || t.split(/[\\/]/).includes('..')) return 'Use a relative name without "..".';
      if (fs.existsSync(path.join(base, t))) return 'That already exists.';
      return null;
    },
  });
  if (name === undefined) return;
  const dir = path.join(base, name.trim());
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Code Helper: could not create ${dir} — ${e.message}`);
    return;
  }
  await startClaude({ path: dir, label: path.basename(dir) });
}

async function resumeClaudeFromUri(uri) {
  const fav = favFromUri(uri);
  if (!fav) { vscode.window.showWarningMessage('Claude Code Helper: no folder selected.'); return; }
  await resumeClaude(fav);
}

async function resumeClaude(fav) {
  if (!fav || !(await checkFavExists(fav))) return;
  const sessions = listSessions(fav.path);
  if (sessions.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      `No previous Claude sessions found for ${fav.label || path.basename(fav.path)}.`,
      'Start new session', 'Cancel'
    );
    if (choice === 'Start new session') await launchClaude(fav, false);
    return;
  }
  if (sessions.length === 1) { await launchClaude(fav, true); return; }
  const buildItem = (s, labelOverride, sessionId) => {
    const m = readSessionMeta(s.file);
    const title = m.title || s.title || s.id;
    const when = `${relativeTime(s.mtime)} · ${new Date(s.mtime).toLocaleString()}`;
    const replySnip = m.lastAssistant ? snippet(oneLine(m.lastAssistant), 140) : null;
    const leadSnip = (m.firstUserMsg && m.firstUserMsg !== title)
      ? snippet(oneLine(m.firstUserMsg), 140) : null;
    const detailParts = [];
    if (leadSnip) detailParts.push(`💬 ${leadSnip}`);
    if (replySnip) detailParts.push(`🤖 ${replySnip}`);
    return {
      label: labelOverride || `$(history) ${title}`,
      description: when,
      detail: detailParts.join('  ·  ') || undefined,
      sessionId,
    };
  };
  const items = [
    buildItem(sessions[0], `$(debug-rerun) Latest session — ${sessions[0].title || readSessionMeta(sessions[0].file).title || sessions[0].id}`, true),
    ...sessions.map((s) => buildItem(s, null, s.id)),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Resume which session in ${fav.label || path.basename(fav.path)}?`,
    matchOnDescription: true, matchOnDetail: true,
  });
  if (!pick) return;
  await launchClaude(fav, pick.sessionId === true ? true : pick.sessionId);
}

module.exports = {
  buildClaudeCommand, defaultSessionName, promptSessionName, pickTerminalMode, launchIcon,
  moveTerminalTabToEnd, runInInternalTerminal, runInExternalTerminal, dtdrainBin,
  userBusReachable, sessionSliceEnv, SCOPE_LIMITS, sliceWrapShell, uniqueAgentTmuxName,
  resolveSessionId, launchClaudeTmux, dtachAttachCmd, dtachStealCmd, bridgeRunnerExports,
  launchClaudeDtach, redrawDtachSessions, isAutoName, renameTerminalTab, scheduleTabTitleRename,
  tabNamesFile, rememberTabName, repairTabNames,
  autoRenameEnabled, rewriteTranscriptPaths, renameScratchSession, sweepScratchRenames,
  launchClaude, startClaude, newScratchSession, favFromUri, startClaudeFromUri,
  newFolderAndStartClaudeFromUri, resumeClaudeFromUri, resumeClaude,
};
