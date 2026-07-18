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

// A YYYY-MM-DD-HHMM folder name — what an unnamed (rocket/scratch) launch produces.
const DATE_NAME_RE = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

// Spaces-free folder slug from an ai-title, e.g. "Connect books.x.com to Kobo" →
// "connect-books-x-com-to-kobo". Same shape as newScratchSession's label slug.
function slugifyTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
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

function runInInternalTerminal(name, cwd, cmd, icon) {
  let terminal;
  if (cfg().get('reuseTerminal')) terminal = findReusableTerminal(cwd);
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd, iconPath: icon });
  terminal.show();
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
      // Rank/label by the last real conversation event, falling back to fs mtime.
      // Idle long-lived sessions get their transcript rewritten without new content,
      // which bumps mtime and makes stale sessions masquerade as "active just now".
      // The `mtime` field carries this corrected value so every downstream
      // relativeTime() / sort uses last-activity instead of the filesystem time.
      try { const ts = readSessionMeta(full).lastTs; if (ts) { const p = Date.parse(ts); if (p) mtime = p; } } catch {}
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

  let customTitle = null, aiTitle = null, firstUserMsg = null, cwd = null, summary = null;
  for (const line of parseLines(headText, false)) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!customTitle && rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
    // Claude Code writes a short, model-generated title from the first prompt as an
    // `ai-title` record (may be refined, so let a later one override — last wins).
    if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
    if (!firstUserMsg && rec.type === 'user' && rec.message) firstUserMsg = extractText(rec.message.content);
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (!summary && rec.type === 'summary' && typeof rec.summary === 'string') summary = rec.summary;
  }

  let lastUser = null, lastAssistant = null, lastTs = null;
  const tailLines = parseLines(tailText, size > HEAD);
  for (const line of tailLines) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
    // Track the newest real conversation event time. fs mtime is unreliable for
    // "last activity": a long-lived idle session keeps getting its transcript
    // rewritten (checkpoint flush — same content), which bumps mtime to "now"
    // even though nothing happened. The event timestamp doesn't lie.
    if (typeof rec.timestamp === 'string') lastTs = rec.timestamp;
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

  // Title priority. Claude auto-sets `custom-title` to the cwd path ("tasks/2026-07-18-0747")
  // and separately generates a short `ai-title` from the first prompt. A real /rename also
  // writes `custom-title`, but to a value that isn't the cwd path — that always wins. For
  // date-coded scratch dirs (launched with no name) the path title is useless, so prefer the
  // ai-title; named dirs keep their meaningful "parent/base" path label.
  const segs = cwd ? cwd.split('/').filter(Boolean) : [];
  const pathNames = new Set();
  if (segs.length) {
    pathNames.add(segs[segs.length - 1]);
    if (segs.length >= 2) pathNames.add(segs.slice(-2).join('/'));
  }
  const realCustom = customTitle && !pathNames.has(customTitle) ? customTitle : null;
  // Prefer the ai-title for our scratch sessions: either still date-coded (unnamed
  // launch) or already auto-renamed to the title's slug (folder base === the slug).
  const base = segs.length ? segs[segs.length - 1] : '';
  const preferAi = !!aiTitle && (DATE_NAME_RE.test(base) || base === slugifyTitle(aiTitle));
  const txt = realCustom || (preferAi ? aiTitle : null) || customTitle || aiTitle || firstUserMsg;
  return {
    title: txt ? txt.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
    aiTitle: aiTitle ? aiTitle.replace(/\s+/g, ' ').trim() : null,
    cwd,
    summary: summary ? summary.replace(/\s+/g, ' ').trim() : null,
    firstUserMsg: firstUserMsg ? firstUserMsg.replace(/\s+/g, ' ').trim() : null,
    lastUser: lastUser ? lastUser.replace(/\s+/g, ' ').trim() : null,
    lastAssistant: lastAssistant ? lastAssistant.replace(/\s+/g, ' ').trim() : null,
    lastTs,
  };
}

function emptyMeta() {
  return { title: null, aiTitle: null, cwd: null, summary: null, firstUserMsg: null, lastUser: null, lastAssistant: null, lastTs: null };
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
  if (session.live) metaLines.push('🟢 running in another window — click to attach here');
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
    const src = path.join(__dirname, 'dtdrain.c');
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
    // Start the (shared) tmux server inside claude.slice so the session it holds
    // lives outside code-server's cgroup. Only the first session starts the server;
    // later new-sessions just reach the existing one, so its slice is set once.
    const tmuxArgs = ['-L', agentSocket(), 'new-session', '-d', '-s', tmuxName, '-c', dir, `bash ${runner}`];
    try {
      if (userBusReachable())
        cp.execFileSync('systemd-run', ['--user', '--scope', '--slice=claude.slice', ...SCOPE_LIMITS, '--quiet', 'tmux', ...tmuxArgs], { env: sessionSliceEnv() });
      else
        cp.execFileSync('tmux', tmuxArgs);
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
  registerSessionTerminal(id, terminal);
  return terminal;
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
  // Only the `dtach -n` master (which holds Claude) goes into claude.slice; the
  // trailing `dtach -a` attach client is a thin, short-lived terminal-side client
  // and is left in place. sliceWrapShell() is '' when the user manager is absent.
  // The attach client is piped through dtdrain (when available) so a flow-control
  // -paused terminal can't back-pressure the master and stall Claude — see
  // dtdrainBin(). dtach does its tty work on stdin, so piping stdout is safe.
  const sock = JSON.stringify(socket);
  const relay = dtdrainBin();
  const attach = `dtach -a ${sock} -E -z -r winch` + (relay ? ` | ${JSON.stringify(relay)}` : '');
  // Steal semantics: kill any attach client already on this socket before we
  // attach, so grabbing a session from another window/machine moves it here
  // instead of mirroring input into both (the old window's client drops back to
  // its shell prompt; the master — and Claude — are untouched). A fresh launch
  // has no clients yet, so the pkill is a no-op there. Runs before our own
  // attach starts, so it can't kill it.
  const steal = `pkill -f ${JSON.stringify('dtach -a ' + socket)} 2>/dev/null`;
  // Leading space keeps this internal launch line out of ~/.bash_history: bash's
  // ignorespace (set via HISTCONTROL=ignoreboth in the default .bashrc the interactive
  // terminal sources) drops space-prefixed commands from the history list. It's our
  // plumbing, not something the user typed, so it shouldn't clutter their history.
  terminal.sendText(` ${steal}; ${sliceWrapShell()}dtach -n ${sock} bash ${JSON.stringify(runner)} 2>/dev/null; ${attach}`);
  registerSessionTerminal(id, terminal);
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

// Rename a specific terminal's tab. renameWithArg targets the *active* terminal, so
// briefly make this one active (keeping keyboard focus in the editor), then restore.
async function renameTerminalTab(terminal, name) {
  if (!terminal || terminal.exitStatus) return;
  const label = name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!label) return;
  const prevActive = vscode.window.activeTerminal;
  terminal.show(true);
  try { await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: label }); } catch {}
  if (prevActive && prevActive !== terminal) { try { prevActive.show(true); } catch {} }
}

// Claude generates a short `ai-title` from the first prompt a few seconds after launch.
// Poll the transcript for it and rename the (date-coded) tab to it. Best-effort: the
// terminal may be closed, or the title may never arrive on a very short session — give
// up after ~50s either way.
function scheduleTabTitleRename(terminal, projectDir, launchTs) {
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
    if (title) { clearInterval(timer); renameTerminalTab(terminal, title); }
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
    if (changed) { writeAgentIndex(idx); if (agentProvider) { try { agentProvider.refresh(); } catch {} } }
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
  if (renamedAny && sessProvider) { try { sessProvider.refresh(); } catch {} }
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
  const mode = await pickTerminalMode();
  if (!mode) return;
  let terminal;
  if (mode === 'internal' && useTmux()) terminal = launchClaudeTmux(fav, resumeArg);
  else if (mode === 'internal' && useDtach()) terminal = launchClaudeDtach(fav, resumeArg);
  else {
    const cmd = buildClaudeCommand(resumeArg);
    if (mode === 'external') runInExternalTerminal(fav.path, cmd);
    else terminal = runInInternalTerminal(fav.label || path.basename(fav.path), fav.path, cmd, launchIcon(resumeArg));
  }
  // Date-coded (unnamed) new launches show a timestamp in the tab; swap it for Claude's
  // generated ai-title once it lands in the transcript. Named launches keep their name.
  if (terminal && resumeArg === false && isAutoName(fav.label)) {
    scheduleTabTitleRename(terminal, fav.path, Date.now());
  }
  // Running sessions are filtered out of Recent Sessions (liveSessionIds); nudge
  // the view shortly after launch so the row disappears now, not on the next 60s
  // tick. Staggered: tmux spawns claude near-instantly, but the dtach/plain paths
  // go through terminal.sendText and a shell startup, so the process can take a
  // few seconds to show up in ps.
  if (sessProvider) for (const ms of [2000, 8000]) setTimeout(() => { try { sessProvider.refresh(); } catch {} }, ms);
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
      // Cheap pre-filter: real activity is always ≤ fs mtime, so an mtime below the
      // cutoff guarantees the session is too old to show — skip without parsing.
      if (st.size === 0 || st.mtimeMs < cutoff) continue;
      // Then rank/bucket by the last real conversation event, not fs mtime. Idle
      // long-lived sessions get their transcript rewritten (checkpoint flush, same
      // content) which bumps mtime to "now", wrongly bubbling days-old sessions into
      // the "Last hour" group. The event timestamp reflects actual activity.
      let activity = st.mtimeMs;
      const ts = readSessionMeta(full).lastTs;
      if (ts) { const p = Date.parse(ts); if (p) activity = p; }
      if (activity < cutoff) continue;
      out.push({ id: f.slice(0, -'.jsonl'.length), file: full, mtime: activity, projectFolder: proj });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, maxItems);
}

// Session ids that have a live claude process right now. Every launch path puts
// the id on the claude command line (--session-id for new sessions, --resume for
// resumes — the tmux/dtach runner scripts and plain-terminal launches alike), so
// one ps scan yields the exact running set. Recent Sessions uses this to decide
// how to present running sessions: hidden when their attach terminal is in THIS
// window (clicking would attach a SECOND client — mirrored input; they're already
// one click away in Running Sessions), shown with a 🟢 marker when they're
// attached elsewhere (another code-server window / machine — the dtach master
// keeps Claude alive across browser disconnects, so without this they'd be
// invisible everywhere but the window that started them). Deliberately NOT
// tmuxHasSession(): the runner keeps a bash alive after claude exits, so
// tmux-liveness would keep hiding sessions that have actually ended.
function liveSessionIds() {
  const ids = new Set();
  try {
    const out = cp.execSync('ps -eo args=', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const re = /--(?:session-id|resume)[ =]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
    for (let m; (m = re.exec(out)); ) ids.add(m[1]);
  } catch { /* ps unavailable — show everything rather than hide wrongly */ }
  return ids;
}

// Terminals this window created for helper-launched sessions, keyed by session
// id. vscode.window.terminals is per-window, which is exactly the point: this
// map lets Recent Sessions distinguish "running with its attach terminal right
// here" (hide the row) from "running, but attached in some other window/machine"
// (show it — see liveSessionIds). Entries drop when their terminal closes. A
// window reload clears the map and restored attach terminals aren't
// re-associated; worst case a session shows 🟢 alongside its own restored
// terminal, and clicking it re-attaches (stealing from the restored client —
// harmless and self-healing).
const sessionTerminals = new Map();
function registerSessionTerminal(id, terminal) { sessionTerminals.set(id, terminal); }
function sessionAttachedHere(id) {
  const t = sessionTerminals.get(id);
  return !!t && vscode.window.terminals.includes(t);
}

// The dtach socket a live session can be re-attached through, or null. Only
// dtach launches are grabbable cross-window from Recent Sessions: tmux launches
// live in the agent index (reachable in any window via Agent Sessions), and
// plain-terminal launches have no master to attach to.
function sessionDtachSocket(id) {
  const sock = path.join(dtachSocketDir(), id + '.sock');
  try { return fs.existsSync(sock) ? sock : null; } catch { return null; }
}

// Two same-titled sessions living in different folders are indistinguishable in
// the tree, so a stale one can be retired: "Hide Session" drops the row but
// leaves the transcript on disk (still resumable from the CLI, and restorable
// here via "Show Hidden Sessions"). "Delete Session" is the destructive sibling
// — it unlinks the .jsonl and the session is gone for good. Session ids are
// uuids, so a flat id list is enough to key the hidden set.
const HIDDEN_KEY = 'claudeHelper.hiddenSessions';
let extCtx = null;

function hiddenSessions() {
  return new Set(extCtx ? extCtx.globalState.get(HIDDEN_KEY, []) : []);
}

async function setHiddenSessions(set) {
  await extCtx.globalState.update(HIDDEN_KEY, [...set]);
  vscode.commands.executeCommand('setContext', 'claudeHelper.hasHiddenSessions', set.size > 0);
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
    this._filter = '';
    this.view = null; // set after createTreeView so we can show the match count
  }
  get filter() { return this._filter; }
  setFilter(q) {
    const next = (q || '').trim();
    if (next === this._filter) return;
    this._filter = next;
    vscode.commands.executeCommand('setContext', 'claudeHelper.sessionsFiltered', !!next);
    this.refresh();
  }
  refresh() { this._cache = null; this._em.fire(); }
  _matches(s, q) {
    const meta = readSessionMeta(s.file);
    const hay = [s.title, meta.title, meta.summary, meta.firstUserMsg, s.id]
      .filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  }
  _load() {
    if (!this._cache) {
      const hidden = hiddenSessions();
      const live = liveSessionIds();
      const all = scanRecentSessions().filter((s) => {
        if (hidden.has(s.id)) return false;
        if (!live.has(s.id)) return true;
        // Running session: hide it when its attach terminal is in this window
        // (reachable via Running Sessions; a second attach would mirror input)
        // or when there's no dtach master to grab (tmux → Agent Sessions view;
        // plain-terminal → nothing to attach to). Otherwise it was started from
        // another window/machine — show it 🟢 so it stays discoverable; resume
        // steals the attach client over to this window.
        if (sessionAttachedHere(s.id) || !sessionDtachSocket(s.id)) return false;
        s.live = true;
        return true;
      });
      const q = this._filter.toLowerCase();
      const sessions = q ? all.filter((s) => this._matches(s, q)) : all;
      if (this.view) {
        this.view.message = q
          ? `Filter “${this._filter}” — ${sessions.length} of ${all.length} session${all.length === 1 ? '' : 's'}`
          : undefined;
      }
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
    it.description = (s.live ? '🟢 ' : '') + relativeTime(s.mtime);
    it.tooltip = buildSessionTooltip(s, meta);
    // Live rows get their own contextValue so the destructive menu entries
    // (Delete Session) don't apply to a session that's still running.
    it.contextValue = s.live ? 'sessionLive' : 'session';
    it.iconPath = s.live
      ? new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('terminal.ansiGreen'))
      : new vscode.ThemeIcon('comment-discussion');
    it.command = { command: 'claudeHelper.resumeSession', title: s.live ? 'Attach Session' : 'Resume Session', arguments: [node] };
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
  // Still running with a dtach master (started from another window/machine, or
  // its terminal here was closed): don't spawn a second claude via --resume —
  // go straight to the dtach path, which attaches to the existing master (its
  // `dtach -n` is a no-op on a live socket) after stealing any other client.
  // Re-checked at click time (not s.live from render time): the session may
  // have ended since, in which case a normal resume is correct.
  if (sessionDtachSocket(s.id) && liveSessionIds().has(s.id)) {
    launchClaudeDtach(fav, s.id);
    return;
  }
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
    // Asana-spawned sessions (from the asana-claude bridge) carry source:'asana'
    // (older entries: a taskGid). Brand them with the Asana logo so they're
    // identifiable at a glance; keep live/ended via a status glyph in the
    // description since a custom SVG icon can't take a ThemeColor.
    const isAsana = e.source === 'asana' || !!e.taskGid;
    item.description = isAsana ? `${live ? '🟢' : '⚫'} ${shortHome(e.dir)}` : shortHome(e.dir);
    let meta = null;
    try { meta = readSessionMeta(agentSessionFile(e)); } catch {}
    item.tooltip = buildAgentTooltip(e, live, meta);
    item.contextValue = live ? 'agentSessionLive' : 'agentSessionEnded';
    item.iconPath = isAsana
      ? vscode.Uri.file(path.join(__dirname, 'resources', 'asana.svg'))
      : new vscode.ThemeIcon(
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
let sessProvider; // module-level so launchClaude can nudge Recent Sessions after a launch

function removeAgentEntry(node) {
  if (!node || !node.entry) return;
  const sessions = readAgentIndex().filter((s) => s.tmuxName !== node.entry.tmuxName);
  writeAgentIndex(sessions);
  agentProvider.refresh();
}

// ─── bookmarks ───────────────────────────────────────────────────────────────

function bookmarksFile() {
  const configured = (cfg().get('bookmarksFile') || '').trim();
  if (configured) return expandHome(configured);
  return path.join(os.homedir(), '.config', 'cc-bookmarks.json');
}

function readBookmarks() {
  const file = bookmarksFile();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fs.existsSync(file)) console.error(`Claude Code Helper: failed to read ${file} — ${e.message}`);
    return [];
  }
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

function writeBookmarks(bookmarks) {
  const file = bookmarksFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Code Helper: ${e.message}`);
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ bookmarks }, null, 2));
}

function ensureBookmarksFile() {
  const file = bookmarksFile();
  if (!fs.existsSync(file)) writeBookmarks([]);
  return file;
}

class BookmarksProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() { this._em.fire(); }
  getTreeItem(bm) {
    const item = new vscode.TreeItem(bm.label, vscode.TreeItemCollapsibleState.None);
    item.tooltip = bm.url;
    item.description = bm.url;
    item.iconPath = new vscode.ThemeIcon(bm.icon || 'globe');
    item.contextValue = 'bookmark';
    item.command = { command: 'claudeHelper.openBookmark', title: 'Open', arguments: [bm] };
    return item;
  }
  getChildren() { return readBookmarks(); }
}

let bookmarksProvider;

// Fetch a URL server-side (extension host is Node), following redirects and
// carrying cookies across them (so token-auth pages like /auto?k=… that 302 to /
// keep their session cookie). Returns { body, finalUrl }.
function httpGetText(rawUrl, { redirects = 5, cookies = '' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const req = mod.request(u, {
      method: 'GET',
      headers: {
        'User-Agent': 'claude-code-helper',
        Accept: 'text/html,application/xhtml+xml,*/*',
        ...(cookies ? { Cookie: cookies } : {}),
      },
    }, (res) => {
      const setCookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
      const merged = [cookies, setCookie].filter(Boolean).join('; ');
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return resolve(httpGetText(next, { redirects: redirects - 1, cookies: merged }));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Inject a <base> (so any relative refs resolve to the real origin) and a CSP that
// permits the panel's own inline <style>/<script> plus https resources + XHRs.
function prepBookmarkHtml(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const base = `<base href="${origin}/">`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri ${origin}; img-src https: data: blob:; media-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; script-src 'unsafe-inline' https:; connect-src https:;">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${base}\n${csp}`);
  return `${base}\n${csp}\n${html}`;
}

// Panels opened via the native-webview path, keyed by URL so a re-click reveals
// the existing tab instead of spawning duplicates.
const bookmarkPanels = new Map();

async function openBookmarkWebview(bm) {
  const existing = bookmarkPanels.get(bm.url);
  if (existing) { existing.reveal(); return; }
  let fetched;
  try {
    fetched = await httpGetText(bm.url);
  } catch (e) {
    vscode.window.showWarningMessage(`Bookmark "${bm.label}": can't render in-editor (${e.message}); opening in Simple Browser.`);
    await vscode.commands.executeCommand('simpleBrowser.show', bm.url);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'claudeHelperBookmark', bm.label || 'Bookmark', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = prepBookmarkHtml(fetched.body, fetched.finalUrl);
  bookmarkPanels.set(bm.url, panel);
  panel.onDidDispose(() => { if (bookmarkPanels.get(bm.url) === panel) bookmarkPanels.delete(bm.url); });
}

// render mode per bookmark (cc-bookmarks.json "render" field):
//   "webview" — rendered as a real VS Code webview tab (Cmd+W closes the tab, not
//               the PWA). Best for self-contained panels served with a token.
//   "browser" — opened as a normal external browser tab (openExternal).
//   "simple"  — VS Code Simple Browser (default; handles arbitrary sites). Note its
//               content is a cross-origin iframe, so Cmd+W with focus inside it is
//               swallowed by the browser and can close the whole PWA window.
async function openBookmark(bm) {
  if (!bm || !bm.url) {
    vscode.window.showErrorMessage('No bookmark URL.');
    return;
  }
  const mode = bm.render || 'simple';
  if (mode === 'webview') return openBookmarkWebview(bm);
  if (mode === 'browser') return vscode.env.openExternal(vscode.Uri.parse(bm.url));
  await vscode.commands.executeCommand('simpleBrowser.show', bm.url);
}

async function addBookmark() {
  const url = await vscode.window.showInputBox({
    title: 'Add Bookmark',
    prompt: 'Bookmark URL',
    placeHolder: 'https://example.com',
    validateInput: (v) => (/^https?:\/\//i.test(v.trim()) ? undefined : 'URL must start with http:// or https://'),
  });
  if (url === undefined) return;
  let defaultLabel = url.trim();
  try { defaultLabel = new URL(url.trim()).hostname; } catch {}
  const label = await vscode.window.showInputBox({
    title: 'Add Bookmark',
    prompt: 'Label',
    value: defaultLabel,
  });
  if (label === undefined) return;
  const bookmarks = readBookmarks();
  bookmarks.push({ label: label.trim() || defaultLabel, url: url.trim() });
  writeBookmarks(bookmarks);
  bookmarksProvider.refresh();
  vscode.window.showInformationMessage(`Bookmark "${label.trim() || defaultLabel}" added.`);
}

async function editBookmark(bm) {
  if (!bm) return;
  const label = await vscode.window.showInputBox({
    title: 'Edit Bookmark',
    prompt: 'Label',
    value: bm.label,
  });
  if (label === undefined) return;
  const url = await vscode.window.showInputBox({
    title: 'Edit Bookmark',
    prompt: 'Bookmark URL',
    value: bm.url,
    validateInput: (v) => (/^https?:\/\//i.test(v.trim()) ? undefined : 'URL must start with http:// or https://'),
  });
  if (url === undefined) return;
  const bookmarks = readBookmarks();
  const idx = bookmarks.findIndex((b) => b.label === bm.label && b.url === bm.url);
  if (idx === -1) return;
  bookmarks[idx] = { ...bookmarks[idx], label: label.trim() || bm.label, url: url.trim() };
  writeBookmarks(bookmarks);
  bookmarksProvider.refresh();
}

async function removeBookmark(bm) {
  if (!bm) return;
  const c = await vscode.window.showWarningMessage(
    `Remove bookmark "${bm.label}"?`, { modal: true }, 'Remove'
  );
  if (c !== 'Remove') return;
  const bookmarks = readBookmarks().filter((b) => !(b.label === bm.label && b.url === bm.url));
  writeBookmarks(bookmarks);
  bookmarksProvider.refresh();
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
  extCtx = context;
  applyFastHoverOnce(context);
  vscode.commands.executeCommand('setContext', 'claudeHelper.hasHiddenSessions', hiddenSessions().size > 0);
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

  sessProvider = new SessionsProvider();
  const sessView = vscode.window.createTreeView('claudeHelper.sessions', {
    treeDataProvider: sessProvider, showCollapseAll: true,
  });
  sessProvider.view = sessView;
  context.subscriptions.push(sessView);

  agentProvider = new AgentSessionsProvider();
  const agentView = vscode.window.createTreeView('claudeHelper.agentSessions', {
    treeDataProvider: agentProvider, showCollapseAll: false,
  });
  context.subscriptions.push(agentView);

  bookmarksProvider = new BookmarksProvider();
  const bookmarksView = vscode.window.createTreeView('claudeHelper.bookmarks', {
    treeDataProvider: bookmarksProvider, showCollapseAll: false,
  });
  context.subscriptions.push(bookmarksView);

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
  reg('claudeHelper.searchSessions', () => {
    const box = vscode.window.createInputBox();
    box.title = 'Search Recent Sessions';
    box.placeholder = 'Filter by session name or summary…';
    box.value = sessProvider.filter;
    box.onDidChangeValue((v) => sessProvider.setFilter(v));
    box.onDidAccept(() => box.hide());
    box.onDidHide(() => box.dispose());
    box.show();
  });
  reg('claudeHelper.clearSessionSearch', () => sessProvider.setFilter(''));
  reg('claudeHelper.resumeSession', (node) => resumeSessionNode(node));
  reg('claudeHelper.hideSession', async (node) => {
    if (!node || node.kind !== 'session') return;
    const s = node.session;
    const hidden = hiddenSessions();
    hidden.add(s.id);
    await setHiddenSessions(hidden);
    sessProvider.refresh();
    const pick = await vscode.window.showInformationMessage(`Hidden: ${s.title || s.id}`, 'Undo');
    if (pick !== 'Undo') return;
    const back = hiddenSessions();
    back.delete(s.id);
    await setHiddenSessions(back);
    sessProvider.refresh();
  });
  reg('claudeHelper.showHiddenSessions', async () => {
    const n = hiddenSessions().size;
    if (!n) { vscode.window.showInformationMessage('No hidden sessions.'); return; }
    await setHiddenSessions(new Set());
    sessProvider.refresh();
    vscode.window.showInformationMessage(`Restored ${n} hidden session${n === 1 ? '' : 's'}.`);
  });
  reg('claudeHelper.deleteSession', async (node) => {
    if (!node || node.kind !== 'session') return;
    const s = node.session;
    const pick = await vscode.window.showWarningMessage(
      `Delete session “${s.title || s.id}”?`,
      { modal: true, detail: `Permanently removes ${s.file}\n\nThe session can never be resumed again.` },
      'Delete',
    );
    if (pick !== 'Delete') return;
    try { fs.unlinkSync(s.file); }
    catch (e) { vscode.window.showErrorMessage(`Claude Code Helper: delete failed — ${e.message}`); return; }
    const hidden = hiddenSessions();
    if (hidden.delete(s.id)) await setHiddenSessions(hidden);
    sessProvider.refresh();
    vscode.window.setStatusBarMessage(`Deleted session ${s.id}`, 3000);
  });
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

  // bookmarks commands
  reg('claudeHelper.refreshBookmarks', () => bookmarksProvider.refresh());
  reg('claudeHelper.addBookmark', () => addBookmark());
  reg('claudeHelper.editBookmark', (bm) => editBookmark(bm));
  reg('claudeHelper.removeBookmark', (bm) => removeBookmark(bm));
  reg('claudeHelper.openBookmark', (bm) => openBookmark(bm));
  reg('claudeHelper.openBookmarksFile', async () => {
    const file = ensureBookmarksFile();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  });

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
    // Closing a session's attach terminal doesn't end the session (the dtach
    // master keeps Claude alive) — drop the map entry and refresh Recent
    // Sessions so the row reappears there as 🟢 running.
    vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of sessionTerminals) if (term === t) sessionTerminals.delete(id);
      refreshTerms();
      if (sessProvider) { try { sessProvider.refresh(); } catch {} }
      // Its claude process may take a moment to exit; sweep shortly after so an
      // ended scratch session's folder gets renamed without waiting for the 60s tick.
      setTimeout(() => { try { sweepScratchRenames(); } catch {} }, 4000);
    }),
    vscode.window.onDidChangeActiveTerminal(refreshTerms),
    vscode.window.onDidChangeTerminalShellIntegration && vscode.window.onDidChangeTerminalShellIntegration(refreshTerms),
    // Window regained focus (fires on browser/notebook reconnect): force live dtach
    // sessions to repaint so a reconnected Claude TUI isn't left frozen on a stale frame.
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) redrawDtachSessions(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeHelper')) { favProvider.refresh(); termProvider.refresh(); sessProvider.refresh(); agentProvider.refresh(); bookmarksProvider.refresh(); }
    })
  );

  // Sessions: light periodic refresh (every 60s) so relative times and new sessions
  // appear; also sweep for ended date-coded scratch folders to auto-rename them.
  const sessTimer = setInterval(() => { try { sweepScratchRenames(); } catch {} sessProvider.refresh(); }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(sessTimer) });
  // Catch sessions that ended while this window was closed.
  setTimeout(() => { try { sweepScratchRenames(); } catch {} }, 5_000);

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
