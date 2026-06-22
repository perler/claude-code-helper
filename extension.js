const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');

// ─── shared ──────────────────────────────────────────────────────────────────

function cfg() {
  return vscode.workspace.getConfiguration('claudeHelper');
}

function shortHome(p) {
  if (!p) return '';
  if (!cfg().get('shortenPaths', true)) return p;
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// ─── favourites ──────────────────────────────────────────────────────────────

const STORE_KEY = 'claudeHelper.favourites';

function getFavs(ctx) {
  return ctx.globalState.get(STORE_KEY, []);
}

async function setFavs(ctx, list) {
  await ctx.globalState.update(STORE_KEY, list);
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function buildClaudeCommand(resumeArg) {
  const c = cfg();
  const cmd = c.get('claudeCommand') || 'claude';
  const parts = [cmd];
  if (c.get('skipPermissions')) parts.push('--dangerously-skip-permissions');
  if (resumeArg === true) parts.push('-c');
  else if (typeof resumeArg === 'string' && resumeArg) parts.push('--resume', resumeArg);
  const extra = (c.get('cliFlags') || '').trim();
  if (extra) parts.push(extra);
  return parts.join(' ');
}

// Timestamp used as the fallback session name when the user leaves the name
// blank — same format as the favourites-tab scratch launcher (YYYY-MM-DD-HHMM).
function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Prompt for a session name on every new-session launch. Empty → timestamp.
// Returns the chosen name, or null if the user cancelled (Esc).
async function promptSessionName() {
  const input = await vscode.window.showInputBox({
    title: 'Start Claude Session',
    prompt: 'Name this session (leave blank for a timestamp).',
    placeHolder: 'e.g. billing-bug — or leave empty for a timestamp',
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

function runInInternalTerminal(name, cwd, cmd, icon) {
  let terminal;
  if (cfg().get('reuseTerminal')) terminal = findReusableTerminal(cwd);
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd, iconPath: icon });
  terminal.show();
  terminal.sendText(cmd);
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

function encodeProjectDir(p) {
  return p.replace(/\//g, '-');
}

const _listCache = new Map();
const LIST_TTL_MS = 5000;

function listSessions(projectDir) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(projectDir));
  const now = Date.now();
  const cached = _listCache.get(dir);
  if (cached && now - cached.t < LIST_TTL_MS) return cached.v;
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const v = files
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { id: f.slice(0, -'.jsonl'.length), file: full, mtime, title: null };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (_listCache.size > 50) _listCache.clear();
  _listCache.set(dir, { t: now, v });
  return v;
}

function extractText(content) {
  // Returns prose text only; skips tool_use / tool_result wrappers.
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (typeof c === 'string') parts.push(c);
      else if (c && typeof c.text === 'string') parts.push(c.text);
    }
    return parts.join(' ').trim() || null;
  }
  return null;
}

function readChunk(file, position, length) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, position);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

const _metaCache = new Map();

function readSessionMeta(file) {
  let st;
  try { st = fs.statSync(file); } catch { return emptyMeta(); }
  const size = st.size;
  if (size === 0) return emptyMeta();
  const key = `${file}:${st.mtimeMs}:${size}`;
  const cached = _metaCache.get(key);
  if (cached) return cached;
  const meta = _readSessionMetaUncached(file, size);
  if (_metaCache.size > 200) _metaCache.clear();
  _metaCache.set(key, meta);
  return meta;
}

function _readSessionMetaUncached(file, size) {

  const HEAD = 16384;
  const TAIL = 65536;
  const headText = readChunk(file, 0, Math.min(HEAD, size));
  const tailText = size > HEAD ? readChunk(file, Math.max(0, size - TAIL), TAIL) : headText;

  const parseLines = (text, dropFirstPartial) => {
    const lines = text.split('\n');
    if (dropFirstPartial && lines.length > 1) lines.shift();
    return lines;
  };

  let customTitle = null, firstUserMsg = null, cwd = null, summary = null;
  for (const line of parseLines(headText, false)) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!customTitle && rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
    if (!firstUserMsg && rec.type === 'user' && rec.message) firstUserMsg = extractText(rec.message.content);
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (!summary && rec.type === 'summary' && typeof rec.summary === 'string') summary = rec.summary;
  }

  let lastUser = null, lastAssistant = null;
  const tailLines = parseLines(tailText, size > HEAD);
  for (const line of tailLines) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'summary' && typeof rec.summary === 'string') summary = rec.summary;
    if (rec.type === 'user' && rec.message) {
      const t = extractText(rec.message.content);
      if (t) lastUser = t;
    }
    if (rec.type === 'assistant' && rec.message) {
      const t = extractText(rec.message.content);
      if (t) lastAssistant = t;
    }
  }

  const txt = customTitle || firstUserMsg;
  return {
    title: txt ? txt.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
    cwd,
    summary: summary ? summary.replace(/\s+/g, ' ').trim() : null,
    firstUserMsg: firstUserMsg ? firstUserMsg.replace(/\s+/g, ' ').trim() : null,
    lastUser: lastUser ? lastUser.replace(/\s+/g, ' ').trim() : null,
    lastAssistant: lastAssistant ? lastAssistant.replace(/\s+/g, ' ').trim() : null,
  };
}

function emptyMeta() {
  return { title: null, cwd: null, summary: null, firstUserMsg: null, lastUser: null, lastAssistant: null };
}

function readSessionTitle(file) {
  return readSessionMeta(file).title;
}

function snippet(s, n) {
  if (!s) return null;
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function escMd(s) { return s.replace(/([\\`*_[\]<>])/g, '\\$1'); }
function oneLine(s) { return s.replace(/\n+/g, ' ').trim(); }

/**
 * Unified tooltip renderer used by all three views.
 *   parts = {
 *     title?:  string,           // optional bold heading on top
 *     lead?:   string,           // prose paragraph below the title
 *     blocks?: [{ label, body, emoji? }],  // optional section blocks
 *     meta:    [string, ...]     // bottom meta lines (already formatted)
 *   }
 */
function buildTooltip(parts) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.supportHtml = false;

  if (parts.title) md.appendMarkdown(`**${escMd(parts.title)}**\n\n`);
  if (parts.lead)  md.appendMarkdown(`${escMd(oneLine(snippet(parts.lead, 600)))}\n`);

  for (const b of parts.blocks || []) {
    if (!b || !b.body) continue;
    const emoji = b.emoji ? `${b.emoji} ` : '';
    md.appendMarkdown(`\n---\n\n**${b.label}**\n\n${emoji}${escMd(oneLine(snippet(b.body, 400)))}\n`);
  }

  if (parts.meta && parts.meta.length) {
    md.appendMarkdown(`\n---\n\n` + parts.meta.join('  \n') + '\n');
  }
  return md;
}

function buildSessionTooltip(session, meta) {
  const lead = meta.firstUserMsg || meta.summary;
  const blocks = [];
  if (meta.summary && meta.summary !== lead) {
    blocks.push({ label: 'Summary', body: meta.summary });
  }
  if (meta.lastAssistant) {
    blocks.push({ label: 'Last reply', body: meta.lastAssistant, emoji: '🤖' });
  }
  const metaLines = [];
  if (meta.cwd) metaLines.push(`📁 \`${meta.cwd}\``);
  metaLines.push(`🆔 \`${session.id}\``);
  metaLines.push(`🕐 ${relativeTime(session.mtime)} · ${new Date(session.mtime).toLocaleString()}`);
  return buildTooltip({ lead, blocks, meta: metaLines });
}

function buildFavouriteTooltip(fav) {
  const sessions = listSessions(fav.path);
  const latest = sessions[0];
  let lead = null;
  const blocks = [];
  if (latest) {
    const m = readSessionMeta(latest.file);
    lead = m.firstUserMsg || m.summary;
    if (m.lastAssistant) blocks.push({ label: 'Last reply', body: m.lastAssistant, emoji: '🤖' });
  }
  const metaLines = [];
  metaLines.push(`📁 \`${fav.path}\``);
  if (latest) {
    metaLines.push(`💬 ${sessions.length} session${sessions.length === 1 ? '' : 's'} · last ${relativeTime(latest.mtime)}`);
  } else {
    metaLines.push('💬 No Claude sessions yet here.');
  }
  return buildTooltip({
    title: fav.label || path.basename(fav.path),
    lead,
    blocks,
    meta: metaLines,
  });
}

function buildTerminalTooltip(terminal, cwd) {
  const isActive = terminal === vscode.window.activeTerminal;
  const tabName = terminalDisplayName(terminal);
  const shellName = (terminal.name || '').trim();

  // Pull the latest Claude session from this terminal's cwd so the
  // tooltip can show the same lead + Last reply as Favourites.
  let lead = null;
  const blocks = [];
  let sessionInfo = null;
  if (cwd) {
    const sessions = listSessions(cwd.fsPath);
    if (sessions.length) {
      const m = readSessionMeta(sessions[0].file);
      lead = m.firstUserMsg || m.summary;
      if (m.lastAssistant) blocks.push({ label: 'Last reply', body: m.lastAssistant, emoji: '🤖' });
      sessionInfo = { count: sessions.length, mtime: sessions[0].mtime };
    }
  }

  const metaLines = [];
  if (cwd) metaLines.push(`📁 \`${cwd.fsPath}\``);
  else metaLines.push('📁 _no cwd available_');
  if (sessionInfo) {
    metaLines.push(`💬 ${sessionInfo.count} session${sessionInfo.count === 1 ? '' : 's'} · last ${relativeTime(sessionInfo.mtime)}`);
  }
  if (shellName && shellName !== tabName) metaLines.push(`🐚 \`${shellName}\``);
  metaLines.push(`${isActive ? '🟢 active' : '⚪ inactive'}`);

  return buildTooltip({
    title: tabName,
    lead,
    blocks,
    meta: metaLines,
  });
}

function relativeTime(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

async function checkFavExists(fav) {
  if (!fs.existsSync(fav.path)) {
    const choice = await vscode.window.showWarningMessage(
      `Path no longer exists:\n${fav.path}`,
      'Remove from Favourites',
      'Dismiss'
    );
    if (choice === 'Remove from Favourites') await removeFavourite(fav, true);
    return false;
  }
  return true;
}

// When useTmux is on (default), an internal-terminal launch runs Claude inside a
// detached tmux session on the shared `-L claude` socket and the VS Code terminal
// attaches to it. This makes every session reachable from Claude Mobile (phone)
// too, and lets sessions survive closing the tab / reloading code-server.
function useTmux() { return cfg().get('useTmux') !== false; }
// When useTmux is off but useDtach is on (the default), an internal-terminal launch
// runs Claude inside a transparent `dtach` session and the VS Code terminal attaches
// to it. dtach's master keeps draining Claude's output even with no client attached,
// so closing the tab no longer blocks Claude's stdout (which is what produced the
// "Stream idle timeout - partial response received" on reconnect). Unlike tmux it has
// no alternate screen, so native wheel-scroll and select/copy keep working.
function useDtach() { return cfg().get('useDtach') !== false; }
function dtachSocketDir() { return expandHome(cfg().get('dtachSocketDir') || '~/.claude/dtach'); }

function tmuxHasSession(name) {
  try { return cp.spawnSync('tmux', ['-L', agentSocket(), 'has-session', '-t', name]).status === 0; }
  catch { return false; }
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
function launchClaudeTmux(fav, resumeArg) {
  const dir = fav.path;
  const c = cfg();
  const bin = c.get('claudeCommand') || 'claude';
  const { id, runArg } = resolveSessionId(dir, resumeArg);
  let entry = readAgentIndex().find((e) => e.sessionId === id);
  let tmuxName = entry && entry.tmuxName;
  if (!tmuxName || !tmuxHasSession(tmuxName)) {
    tmuxName = tmuxName || uniqueAgentTmuxName(dir);
    const parts = [bin];
    if (c.get('skipPermissions')) parts.push('--dangerously-skip-permissions');
    parts.push(...runArg);
    const extra = (c.get('cliFlags') || '').trim(); if (extra) parts.push(extra);
    const cmd = parts.join(' ');
    const runner = path.join(dir, '.run-claude.sh');
    try {
      fs.writeFileSync(runner,
        `#!/usr/bin/env bash\ncd ${JSON.stringify(dir)}\n${cmd}\necho\necho "[claude session ended — resume with: ${bin} --resume ${id} --dangerously-skip-permissions]"\nexec bash\n`,
        { mode: 0o755 });
    } catch (e) { vscode.window.showErrorMessage(`Claude Code Helper: ${e.message}`); return; }
    try {
      cp.execFileSync('tmux', ['-L', agentSocket(), 'new-session', '-d', '-s', tmuxName, '-c', dir, `bash ${runner}`]);
    } catch (e) { vscode.window.showErrorMessage(`Claude Code Helper: tmux launch failed — ${e.message}`); return; }
    cp.spawnSync('tmux', ['-L', agentSocket(), 'kill-session', '-t', '0']);
    cp.spawnSync('tmux', ['-L', agentSocket(), 'set-option', '-g', 'mouse', 'off']);
    cp.spawnSync('tmux', ['-L', agentSocket(), 'set-option', '-g', 'status', 'off']);
    const sessions = readAgentIndex().filter((e) => e.sessionId !== id && e.tmuxName !== tmuxName);
    sessions.push({ sessionId: id, tmuxName, dir, displayName: fav.label || path.basename(dir), source: 'helper', createdAt: new Date().toISOString() });
    writeAgentIndex(sessions);
    if (agentProvider) { try { agentProvider.refresh(); } catch {} }
  }
  // name = bare folder/label so VS Code drops the duplicate ${cwdFolder} description.
  const name = fav.label || path.basename(dir);
  let terminal = cfg().get('reuseTerminal') ? findReusableTerminal(dir) : null;
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd: dir, iconPath: launchIcon(resumeArg) });
  terminal.show();
  terminal.sendText(`tmux -L ${agentSocket()} attach -t ${tmuxName}`);
}

function launchClaudeDtach(fav, resumeArg) {
  const dir = fav.path;
  const c = cfg();
  const bin = c.get('claudeCommand') || 'claude';
  const { id, runArg } = resolveSessionId(dir, resumeArg);
  const parts = [bin];
  if (c.get('skipPermissions')) parts.push('--dangerously-skip-permissions');
  parts.push(...runArg);
  const extra = (c.get('cliFlags') || '').trim(); if (extra) parts.push(extra);
  const cmd = parts.join(' ');
  const runner = path.join(dir, '.run-claude.sh');
  try {
    fs.writeFileSync(runner,
      `#!/usr/bin/env bash\ncd ${JSON.stringify(dir)}\n${cmd}\necho\necho "[claude session ended — resume with: ${bin} --resume ${id} --dangerously-skip-permissions]"\nexec bash\n`,
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
  let terminal = cfg().get('reuseTerminal') ? findReusableTerminal(dir) : null;
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd: dir, iconPath: launchIcon(resumeArg) });
  terminal.show();
  // Create the master detached (no controlling terminal), then attach a client.
  // This keeps the claude process's lifetime fully independent of this code-server
  // terminal — parity with the Asana bridge's `dtach -n` — instead of `dtach -A`,
  // which parents the master under the interactive client. `dtach -n` is a harmless
  // no-op (errors, swallowed) when the session is already live, so re-opening just
  // re-attaches and the trailing `dtach -a` always fires a fresh -r winch redraw.
  // -E: no detach escape char; -z: pass Ctrl-Z through; -r winch: redraw on attach.
  const sock = JSON.stringify(socket);
  terminal.sendText(`dtach -n ${sock} bash ${JSON.stringify(runner)} 2>/dev/null; dtach -a ${sock} -E -z -r winch`);
}

// On a *silent* code-server reconnect (the browser/notebook drops and re-establishes
// its websocket) the dtach client stays attached the whole time, so no re-attach
// fires and `-r winch` never re-triggers — the full-screen Claude TUI shows stale
// output and looks frozen, even though the process is alive and well. Nudge every
// dtach master (a `dtach` process with no controlling tty) with SIGWINCH; the program
// repaints and dtach forwards the fresh frame to the reconnected client. SIGWINCH is
// benign — sessions that don't need it simply repaint.
function redrawDtachSessions() {
  try {
    cp.exec(`ps -e -o pid=,tty=,comm= | awk '$2=="?" && $3=="dtach"{print $1}' | xargs -r kill -WINCH`);
  } catch { /* best-effort redraw nudge */ }
}

async function launchClaude(fav, resumeArg, opts = {}) {
  // Every new-session launch asks for a name first (timestamp if left blank).
  // Resumes keep the existing session, so they skip the prompt; newScratchSession
  // already prompts for its folder name and passes skipNamePrompt to avoid asking twice.
  if (resumeArg === false && !opts.skipNamePrompt) {
    const name = await promptSessionName();
    if (name === null) return; // cancelled
    fav = { ...fav, label: name };
  }
  const mode = await pickTerminalMode();
  if (!mode) return;
  if (mode === 'internal' && useTmux()) { launchClaudeTmux(fav, resumeArg); return; }
  if (mode === 'internal' && useDtach()) { launchClaudeDtach(fav, resumeArg); return; }
  const cmd = buildClaudeCommand(resumeArg);
  if (mode === 'external') runInExternalTerminal(fav.path, cmd);
  else runInInternalTerminal(fav.label || path.basename(fav.path), fav.path, cmd, launchIcon(resumeArg));
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

let favProvider;

async function addFavouriteFromUri(ctx, uri, opts = {}) {
  const p = uri && uri.fsPath;
  if (!p) return;
  try {
    if (!fs.statSync(p).isDirectory()) {
      vscode.window.showWarningMessage('Claude Code Helper: please pick a directory.');
      return;
    }
  } catch {
    vscode.window.showWarningMessage(`Path does not exist: ${p}`);
    return;
  }
  const favs = getFavs(ctx);
  if (favs.find((f) => f.path === p)) {
    vscode.window.showInformationMessage('Already in favourites.');
    return;
  }
  let label;
  if (opts.askLabel !== false) {
    label = await vscode.window.showInputBox({
      prompt: 'Display name (leave empty to use folder name)',
      value: path.basename(p),
    });
    if (label === undefined) return;
    if (!label.trim() || label.trim() === path.basename(p)) label = undefined;
  }
  favs.push({ id: makeId(), path: p, label });
  await setFavs(ctx, favs);
  favProvider.refresh();
}

async function removeFavourite(fav, skipConfirm) {
  if (!fav) return;
  if (!skipConfirm && cfg().get('confirmRemove')) {
    const name = fav.label || path.basename(fav.path);
    const c = await vscode.window.showWarningMessage(
      `Remove "${name}" from Claude Favourites?`, { modal: true }, 'Remove'
    );
    if (c !== 'Remove') return;
  }
  const favs = getFavs(favProvider.ctx).filter((f) => f.id !== fav.id);
  await setFavs(favProvider.ctx, favs);
  favProvider.refresh();
}

class FavouritesProvider {
  constructor(ctx) {
    this.ctx = ctx;
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() { this._em.fire(); }
  getTreeItem(fav) {
    const name = fav.label || path.basename(fav.path) || fav.path;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.description = shortHome(fav.path);
    item.tooltip = buildFavouriteTooltip(fav);
    item.contextValue = 'favourite';
    item.resourceUri = vscode.Uri.file(fav.path);
    item.iconPath = new vscode.ThemeIcon('folder');
    item.command = { command: 'claudeHelper.resumeClaude', title: 'Resume Claude', arguments: [fav] };
    return item;
  }
  getChildren() { return getFavs(this.ctx); }
}

// ─── terminals ───────────────────────────────────────────────────────────────

const SHELL_NAMES = new Set([
  'bash', 'zsh', 'sh', 'fish', 'dash', 'ksh',
  'pwsh', 'powershell', 'cmd', 'wsl', 'tmux', 'screen',
]);

function terminalDisplayName(terminal) {
  const explicit = terminal.creationOptions && terminal.creationOptions.name;
  if (explicit && !SHELL_NAMES.has(explicit.toLowerCase())) return explicit;
  const n = (terminal.name || '').trim();
  if (n && !SHELL_NAMES.has(n.toLowerCase())) return n;
  // terminal.name is just a shell name (bash/zsh/…) — VS Code may show a
  // shell-set OSC title in the tab, but that's not exposed via the API.
  // Fall back to the cwd basename as a stable, meaningful label.
  const cwd = getTerminalCwd(terminal);
  if (cwd) return path.basename(cwd.fsPath);
  return n || '—';
}

function findReusableTerminal(dir) {
  return vscode.window.terminals.find((t) => {
    const c = getTerminalCwd(t);
    return c && c.fsPath === dir;
  });
}

function getTerminalCwd(terminal) {
  const shellCwd = terminal.shellIntegration && terminal.shellIntegration.cwd;
  if (shellCwd) return shellCwd instanceof vscode.Uri ? shellCwd : vscode.Uri.file(String(shellCwd));
  const opts = terminal.creationOptions || {};
  if (opts.cwd) return opts.cwd instanceof vscode.Uri ? opts.cwd : vscode.Uri.file(String(opts.cwd));
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri;
  return undefined;
}

class TerminalsProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() { this._em.fire(); }
  getTreeItem(node) { return node.treeItem; }
  getChildren() {
    const showWithoutCwd = cfg().get('showTerminalsWithoutCwd', true);
    const active = vscode.window.activeTerminal;
    const out = [];
    for (const t of vscode.window.terminals) {
      const cwd = getTerminalCwd(t);
      if (!cwd && !showWithoutCwd) continue;
      const isActive = t === active;
      const item = new vscode.TreeItem(terminalDisplayName(t), vscode.TreeItemCollapsibleState.None);
      item.description = cwd ? shortHome(cwd.fsPath) : 'no cwd';
      item.tooltip = buildTerminalTooltip(t, cwd);
      item.contextValue = 'terminal';
      item.iconPath = new vscode.ThemeIcon(
        'terminal',
        isActive ? new vscode.ThemeColor('terminal.ansiGreen') : new vscode.ThemeColor('disabledForeground')
      );
      const node = { terminal: t, cwd, treeItem: item };
      item.command = { command: 'claudeHelper.focusTerminal', title: 'Focus Terminal', arguments: [node] };
      out.push(node);
    }
    return out;
  }
}

// ─── recent sessions ─────────────────────────────────────────────────────────

function scanRecentSessions() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const maxAgeMs = (cfg().get('sessionsMaxAgeDays', 7) || 7) * 24 * 3600 * 1000;
  const maxItems = cfg().get('sessionsMaxItems', 100) || 100;
  const cutoff = Date.now() - maxAgeMs;
  let projects;
  try { projects = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const proj of projects) {
    const dir = path.join(root, proj);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size === 0 || st.mtimeMs < cutoff) continue;
      out.push({ id: f.slice(0, -'.jsonl'.length), file: full, mtime: st.mtimeMs, projectFolder: proj });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, maxItems);
}

function decodeProjectFolder(folder) {
  // best-effort: replace - with /, then verify existence
  const decoded = folder.replace(/-/g, '/');
  if (fs.existsSync(decoded)) return decoded;
  return null;
}

function getSessionCwd(s) {
  if (s.cwd) return s.cwd;
  const meta = readSessionMeta(s.file);
  s.title = s.title || meta.title;
  s.cwd = meta.cwd || decodeProjectFolder(s.projectFolder);
  return s.cwd;
}

function bucketFor(ms) {
  const now = Date.now();
  const diff = now - ms;
  if (diff < 3600 * 1000) return { key: '0_hour', label: 'Last hour' };
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  if (ms >= today0.getTime()) return { key: '1_today', label: 'Today' };
  const yesterday0 = today0.getTime() - 24 * 3600 * 1000;
  if (ms >= yesterday0) return { key: '2_yesterday', label: 'Yesterday' };
  return { key: '3_week', label: 'Earlier this week' };
}

class SessionsProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
    this._cache = null;
  }
  refresh() { this._cache = null; this._em.fire(); }
  _load() {
    if (!this._cache) {
      const sessions = scanRecentSessions();
      const groups = new Map();
      for (const s of sessions) {
        const b = bucketFor(s.mtime);
        if (!groups.has(b.key)) groups.set(b.key, { key: b.key, label: b.label, sessions: [] });
        groups.get(b.key).sessions.push(s);
      }
      this._cache = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
    return this._cache;
  }
  getTreeItem(node) {
    if (node.kind === 'group') {
      const it = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      it.description = `${node.sessions.length}`;
      it.contextValue = 'sessionGroup';
      return it;
    }
    const s = node.session;
    const meta = readSessionMeta(s.file);
    const title = s.title || meta.title || s.id;
    if (!s.title) s.title = title;
    if (!s.cwd && meta.cwd) s.cwd = meta.cwd;
    getSessionCwd(s); // populate s.cwd for the tooltip
    const it = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    it.description = relativeTime(s.mtime);
    it.tooltip = buildSessionTooltip(s, meta);
    it.contextValue = 'session';
    it.iconPath = new vscode.ThemeIcon('comment-discussion');
    it.command = { command: 'claudeHelper.resumeSession', title: 'Resume Session', arguments: [node] };
    return it;
  }
  getChildren(node) {
    if (!node) return this._load().map((g) => ({ kind: 'group', ...g }));
    if (node.kind === 'group') return node.sessions.map((s) => ({ kind: 'session', session: s }));
    return [];
  }
}

async function resumeSessionNode(node) {
  if (!node || node.kind !== 'session') return;
  const s = node.session;
  const cwd = getSessionCwd(s);
  if (!cwd) {
    vscode.window.showErrorMessage(`Can't determine working directory for session ${s.id}.`);
    return;
  }
  if (!fs.existsSync(cwd)) {
    vscode.window.showErrorMessage(`Session's project folder no longer exists: ${cwd}`);
    return;
  }
  const fav = { path: cwd, label: path.basename(cwd) };
  await launchClaude(fav, s.id);
}

// ─── agent sessions (Asana → Claude bridge) ───────────────────────────────────
//
// The bridge spawns each picked-up task as an INTERACTIVE claude inside a
// detached tmux session (on a dedicated -L socket) and records it in an index
// file. These sessions run in the background — outside VS Code — so they never
// appear in "Running Sessions". This view surfaces them: 🟢 live ones attach
// (reconnect to the running process), ⚫ ended ones resume from the transcript.

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function agentSocket() {
  return cfg().get('agentTmuxSocket') || 'claude';
}

function agentIndexFile() {
  return expandHome(cfg().get('agentIndexPath') || '~/.claude/agent-sessions.json');
}

function readAgentIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(agentIndexFile(), 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch { return []; }
}

function writeAgentIndex(sessions) {
  const file = agentIndexFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
  fs.renameSync(tmp, file);
}

function tmuxAlive(name) {
  try {
    return cp.spawnSync('tmux', ['-L', agentSocket(), 'has-session', '-t', name]).status === 0;
  } catch { return false; }
}

function agentSessionFile(entry) {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(entry.dir), `${entry.sessionId}.jsonl`);
}

function buildAgentTooltip(entry, live, meta) {
  const blocks = [];
  if (meta && meta.lastAssistant) blocks.push({ label: 'Last reply', body: meta.lastAssistant, emoji: '🤖' });
  const metaLines = [];
  metaLines.push(`📁 \`${entry.dir}\``);
  if (entry.permalink) metaLines.push(`🔗 ${entry.permalink}`);
  metaLines.push(`🖥️ \`tmux -L ${agentSocket()} attach -t ${entry.tmuxName}\``);
  metaLines.push(`🆔 \`${entry.sessionId}\``);
  metaLines.push(live ? '🟢 running' : '⚫ ended');
  if (entry.createdAt) metaLines.push(`🕐 started ${new Date(entry.createdAt).toLocaleString()}`);
  return buildTooltip({
    title: entry.displayName,
    lead: meta ? (meta.firstUserMsg || meta.summary) : null,
    blocks,
    meta: metaLines,
  });
}

class AgentSessionsProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() { this._em.fire(); }
  getTreeItem(node) {
    const e = node.entry;
    const live = node.live;
    const item = new vscode.TreeItem(e.displayName || path.basename(e.dir), vscode.TreeItemCollapsibleState.None);
    // Match the other views: name as label, directory as the dimmed description.
    // Live/ended status is conveyed by the icon colour (and the tooltip).
    item.description = shortHome(e.dir);
    let meta = null;
    try { meta = readSessionMeta(agentSessionFile(e)); } catch {}
    item.tooltip = buildAgentTooltip(e, live, meta);
    item.contextValue = live ? 'agentSessionLive' : 'agentSessionEnded';
    item.iconPath = new vscode.ThemeIcon(
      live ? 'vm-running' : 'vm-outline',
      new vscode.ThemeColor(live ? 'terminal.ansiGreen' : 'disabledForeground')
    );
    item.command = live
      ? { command: 'claudeHelper.attachAgentSession', title: 'Attach Session', arguments: [node] }
      : { command: 'claudeHelper.resumeAgentSession', title: 'Resume Session', arguments: [node] };
    return item;
  }
  getChildren() {
    const entries = readAgentIndex();
    const nodes = entries.map((entry) => ({ entry, live: tmuxAlive(entry.tmuxName) }));
    // live first, then most-recently started
    nodes.sort((a, b) => (b.live - a.live) || (String(b.entry.createdAt).localeCompare(String(a.entry.createdAt))));
    return nodes;
  }
}

function attachAgentSession(node) {
  if (!node || !node.entry) return;
  const e = node.entry;
  if (!tmuxAlive(e.tmuxName)) {
    vscode.window.showWarningMessage(`Agent session "${e.displayName}" is no longer running — resuming instead.`);
    return resumeAgentSession(node);
  }
  const name = `▶ ${e.displayName}`;
  let terminal = vscode.window.terminals.find((t) => t.name === name);
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd: fs.existsSync(e.dir) ? e.dir : undefined });
  terminal.show();
  terminal.sendText(`tmux -L ${agentSocket()} attach -t ${e.tmuxName}`);
}

async function resumeAgentSession(node) {
  if (!node || !node.entry) return;
  const e = node.entry;
  if (!fs.existsSync(e.dir)) {
    vscode.window.showErrorMessage(`Project folder no longer exists: ${e.dir}`);
    return;
  }
  await launchClaude({ path: e.dir, label: e.displayName }, e.sessionId);
}

let agentProvider;

function removeAgentEntry(node) {
  if (!node || !node.entry) return;
  const sessions = readAgentIndex().filter((s) => s.tmuxName !== node.entry.tmuxName);
  writeAgentIndex(sessions);
  agentProvider.refresh();
}

// ─── activation ──────────────────────────────────────────────────────────────

async function applyFastHoverOnce(context) {
  const FLAG = 'claudeHelper.fastHoverApplied';
  if (context.globalState.get(FLAG)) return;
  try {
    const hoverCfg = vscode.workspace.getConfiguration('workbench.hover');
    const current = hoverCfg.inspect('delay');
    const globalVal = current && current.globalValue;
    if (globalVal === undefined || globalVal > 100) {
      await hoverCfg.update('delay', 100, vscode.ConfigurationTarget.Global);
    }
    await context.globalState.update(FLAG, true);
  } catch (e) {
    // ignore; user can still set it manually
  }
}

function activate(context) {
  applyFastHoverOnce(context);
  favProvider = new FavouritesProvider(context);
  const favView = vscode.window.createTreeView('claudeHelper.favourites', {
    treeDataProvider: favProvider, showCollapseAll: false,
  });
  context.subscriptions.push(favView);

  const termProvider = new TerminalsProvider();
  const termView = vscode.window.createTreeView('claudeHelper.terminals', {
    treeDataProvider: termProvider, showCollapseAll: false,
  });
  context.subscriptions.push(termView);

  const sessProvider = new SessionsProvider();
  const sessView = vscode.window.createTreeView('claudeHelper.sessions', {
    treeDataProvider: sessProvider, showCollapseAll: true,
  });
  context.subscriptions.push(sessView);

  agentProvider = new AgentSessionsProvider();
  const agentView = vscode.window.createTreeView('claudeHelper.agentSessions', {
    treeDataProvider: agentProvider, showCollapseAll: false,
  });
  context.subscriptions.push(agentView);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // favourites commands
  reg('claudeHelper.refreshFavourites', () => favProvider.refresh());
  reg('claudeHelper.addFavourite', async () => {
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: true,
      openLabel: 'Add to Claude Favourites',
      defaultUri: vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri,
    });
    if (!picks) return;
    for (const uri of picks) await addFavouriteFromUri(context, uri, { askLabel: picks.length === 1 });
  });
  reg('claudeHelper.addCurrentWorkspace', async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) { vscode.window.showInformationMessage('No workspace folder open.'); return; }
    for (const f of folders) await addFavouriteFromUri(context, f.uri, { askLabel: folders.length === 1 });
  });
  reg('claudeHelper.addFromExplorer', (uri) => addFavouriteFromUri(context, uri));
  reg('claudeHelper.newSession', () => newScratchSession());
  reg('claudeHelper.startClaude', (fav) => startClaude(fav));
  reg('claudeHelper.resumeClaude', (fav) => resumeClaude(fav));
  reg('claudeHelper.startClaudeFromExplorer', (uri) => startClaudeFromUri(uri));
  reg('claudeHelper.resumeClaudeFromExplorer', (uri) => resumeClaudeFromUri(uri));
  reg('claudeHelper.openTerminalHere', (fav) => {
    if (!fav) return;
    const t = vscode.window.createTerminal({ name: fav.label || path.basename(fav.path), cwd: fav.path });
    t.show();
  });
  reg('claudeHelper.openFolder', (fav) => {
    if (!fav) return;
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(fav.path), { forceNewWindow: true });
  });
  reg('claudeHelper.revealInExplorer', (fav) => {
    if (!fav) return;
    vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fav.path));
  });
  reg('claudeHelper.copyPath', (fav) => {
    if (!fav) return;
    vscode.env.clipboard.writeText(fav.path);
    vscode.window.setStatusBarMessage(`Copied: ${fav.path}`, 2000);
  });
  reg('claudeHelper.renameFavourite', async (fav) => {
    if (!fav) return;
    const value = await vscode.window.showInputBox({
      prompt: 'New display name (empty to use folder name)',
      value: fav.label || path.basename(fav.path),
    });
    if (value === undefined) return;
    const favs = getFavs(context);
    const target = favs.find((f) => f.id === fav.id);
    if (!target) return;
    const folderName = path.basename(target.path);
    target.label = !value.trim() || value.trim() === folderName ? undefined : value.trim();
    await setFavs(context, favs);
    favProvider.refresh();
  });
  reg('claudeHelper.removeFavourite', (fav) => removeFavourite(fav, false));
  const move = async (fav, delta) => {
    if (!fav) return;
    const favs = getFavs(context);
    const idx = favs.findIndex((f) => f.id === fav.id);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= favs.length) return;
    const [it] = favs.splice(idx, 1);
    favs.splice(next, 0, it);
    await setFavs(context, favs);
    favProvider.refresh();
  };
  reg('claudeHelper.moveUp', (fav) => move(fav, -1));
  reg('claudeHelper.moveDown', (fav) => move(fav, 1));

  // terminals commands
  reg('claudeHelper.refreshTerminals', () => termProvider.refresh());
  reg('claudeHelper.newTerminal', () => vscode.commands.executeCommand('workbench.action.terminal.new'));
  reg('claudeHelper.focusTerminal', (node) => {
    if (!node || !node.terminal) return;
    node.terminal.show(false);
  });
  reg('claudeHelper.revealTerminalCwd', (node) => {
    if (!node) return;
    const cwd = node.cwd || getTerminalCwd(node.terminal);
    if (!cwd) { vscode.window.showInformationMessage('No working directory available.'); return; }
    vscode.commands.executeCommand('revealInExplorer', cwd);
  });
  reg('claudeHelper.copyTerminalCwd', (node) => {
    if (!node) return;
    const cwd = node.cwd || getTerminalCwd(node.terminal);
    if (!cwd) return;
    vscode.env.clipboard.writeText(cwd.fsPath);
    vscode.window.setStatusBarMessage(`Copied: ${cwd.fsPath}`, 2000);
  });
  reg('claudeHelper.renameTerminal', async (node) => {
    if (!node || !node.terminal) return;
    node.terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.rename');
  });
  reg('claudeHelper.splitTerminal', async (node) => {
    if (!node || !node.terminal) return;
    node.terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.split');
  });
  reg('claudeHelper.killTerminal', async (node) => {
    if (!node || !node.terminal) return;
    if (cfg().get('confirmKillTerminal')) {
      const c = await vscode.window.showWarningMessage(
        `Kill terminal "${node.terminal.name}"?`, { modal: true }, 'Kill'
      );
      if (c !== 'Kill') return;
    }
    node.terminal.dispose();
  });
  // session commands
  reg('claudeHelper.refreshSessions', () => sessProvider.refresh());
  reg('claudeHelper.resumeSession', (node) => resumeSessionNode(node));
  reg('claudeHelper.openSessionFolder', (node) => {
    if (!node || node.kind !== 'session') return;
    const cwd = getSessionCwd(node.session);
    if (!cwd) { vscode.window.showWarningMessage('Unknown project folder for this session.'); return; }
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), { forceNewWindow: true });
  });
  reg('claudeHelper.copySessionId', (node) => {
    if (!node || node.kind !== 'session') return;
    vscode.env.clipboard.writeText(node.session.id);
    vscode.window.setStatusBarMessage(`Copied session id: ${node.session.id}`, 2000);
  });
  reg('claudeHelper.copySessionPath', (node) => {
    if (!node || node.kind !== 'session') return;
    vscode.env.clipboard.writeText(node.session.file);
    vscode.window.setStatusBarMessage(`Copied: ${node.session.file}`, 2000);
  });
  reg('claudeHelper.revealSessionFile', (node) => {
    if (!node || node.kind !== 'session') return;
    vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.session.file));
  });

  // agent sessions commands
  reg('claudeHelper.refreshAgentSessions', () => agentProvider.refresh());
  reg('claudeHelper.attachAgentSession', (node) => attachAgentSession(node));
  reg('claudeHelper.resumeAgentSession', (node) => resumeAgentSession(node));
  reg('claudeHelper.openAgentSessionFolder', (node) => {
    if (!node || !node.entry) return;
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.entry.dir), { forceNewWindow: true });
  });
  reg('claudeHelper.openAgentTask', (node) => {
    if (!node || !node.entry || !node.entry.permalink) {
      vscode.window.showInformationMessage('No Asana link recorded for this session.');
      return;
    }
    vscode.env.openExternal(vscode.Uri.parse(node.entry.permalink));
  });
  reg('claudeHelper.copyAgentSessionId', (node) => {
    if (!node || !node.entry) return;
    vscode.env.clipboard.writeText(node.entry.sessionId);
    vscode.window.setStatusBarMessage(`Copied session id: ${node.entry.sessionId}`, 2000);
  });
  reg('claudeHelper.killAgentSession', async (node) => {
    if (!node || !node.entry) return;
    const c = await vscode.window.showWarningMessage(
      `Kill agent session "${node.entry.displayName}"? The claude process will stop.`, { modal: true }, 'Kill'
    );
    if (c !== 'Kill') return;
    try { cp.spawnSync('tmux', ['-L', agentSocket(), 'kill-session', '-t', node.entry.tmuxName]); } catch {}
    removeAgentEntry(node);
  });
  reg('claudeHelper.removeAgentSession', (node) => removeAgentEntry(node));

  reg('claudeHelper.revealActiveTerminalCwd', () => {
    const t = vscode.window.activeTerminal;
    if (!t) { vscode.window.showInformationMessage('No active terminal.'); return; }
    const cwd = getTerminalCwd(t);
    if (!cwd) { vscode.window.showInformationMessage('No working directory available.'); return; }
    vscode.commands.executeCommand('revealInExplorer', cwd);
  });

  const refreshTerms = () => termProvider.refresh();
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(refreshTerms),
    vscode.window.onDidCloseTerminal(refreshTerms),
    vscode.window.onDidChangeActiveTerminal(refreshTerms),
    vscode.window.onDidChangeTerminalShellIntegration && vscode.window.onDidChangeTerminalShellIntegration(refreshTerms),
    // Window regained focus (fires on browser/notebook reconnect): force live dtach
    // sessions to repaint so a reconnected Claude TUI isn't left frozen on a stale frame.
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) redrawDtachSessions(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeHelper')) { favProvider.refresh(); termProvider.refresh(); sessProvider.refresh(); agentProvider.refresh(); }
    })
  );

  // Sessions: light periodic refresh (every 60s) so relative times and new sessions appear.
  const sessTimer = setInterval(() => sessProvider.refresh(), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(sessTimer) });

  // Agent Sessions: faster refresh (15s) so live/ended status and new pickups
  // appear promptly, plus a watcher on the index file for instant updates.
  const agentTimer = setInterval(() => agentProvider.refresh(), 15_000);
  context.subscriptions.push({ dispose: () => clearInterval(agentTimer) });
  try {
    const idxFile = agentIndexFile();
    const watcher = fs.watch(path.dirname(idxFile), (_evt, fname) => {
      if (!fname || fname.startsWith(path.basename(idxFile))) agentProvider.refresh();
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch { /* dir may not exist yet; timer still covers it */ }
}

function deactivate() {}

module.exports = { activate, deactivate };
