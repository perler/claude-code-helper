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

// Single-quote a string for a POSIX shell. Used for the initial-prompt argument,
// which is arbitrary user text and ends up inside .run-claude.sh / sendText.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

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

function buildTerminalTooltip(terminal, cwd, task) {
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
  if (task) metaLines.push(`🔗 ${task.permalink}`);
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
function launchClaudeTmux(fav, resumeArg, initialPrompt) {
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
  let terminal = cfg().get('reuseTerminal') ? findReusableTerminal(dir) : null;
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd: dir, iconPath: launchIcon(resumeArg) });
  terminal.show();
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
  if (terminal && resumeArg === false && isAutoName(fav.label)) {
    scheduleTabTitleRename(terminal, fav.path, Date.now());
  }
  // Running sessions are filtered out of Recent Sessions (liveSessionIds); nudge
  // the view shortly after launch so the row disappears now, not on the next 60s
  // tick. Staggered: tmux spawns claude near-instantly, but the dtach/plain paths
  // go through terminal.sendText and a shell startup, so the process can take a
  // few seconds to show up in ps.
  if (sessProvider) for (const ms of [2000, 8000]) setTimeout(() => { try { sessProvider.refresh(); } catch {} }, ms);
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

function titleModel() { return cfg().get('titleModel') || 'claude-haiku-4-5-20251001'; }

// Keep at most the first two hyphen-separated words of whatever the model echoed
// back, and make it filesystem-safe. Returns '' when nothing usable came out.
function sanitiseSlug(raw) {
  const line = String(raw || '').trim().split('\n').filter(Boolean).pop() || '';
  const words = line.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean);
  return words.slice(0, 2).join('-').slice(0, 40);
}

// ── the Asana project list ───────────────────────────────────────────────────
//
// What the box types most often isn't a coding question, it's "asana <subject>" or
// "email <subject>". For those the Asana project the item belongs to is what decides
// the folder, so the project list is part of the routing table, not an afterthought.
// `asana projects` takes ~0.8s, which is too much to pay on every submit, so the list
// is cached on disk and refreshed in the background.

function asanaCommand() { return expandHome((cfg().get('asanaCommand') || '').trim()); }
function asanaCacheFile() { return path.join(os.homedir(), '.cache', 'claude-code-helper', 'asana-projects.json'); }

// `asana projects` prints a grouped text list: "   • BF EDV" then "     ID: 620…".
function parseAsanaProjects(stdout) {
  const out = [];
  let name = null;
  for (const line of String(stdout || '').split('\n')) {
    const n = line.match(/^\s*•\s+(.*\S)\s*$/);
    if (n) { name = n[1]; continue; }
    const id = line.match(/^\s*ID:\s*(\d+)\s*$/);
    if (id && name) { out.push({ name, gid: id[1] }); name = null; }
  }
  return out;
}

function loadAsanaProjects() {
  try { return JSON.parse(fs.readFileSync(asanaCacheFile(), 'utf8')); } catch { return []; }
}

// Fire-and-forget: a stale list still routes correctly, an absent one only costs the
// Asana half of the decision, so nothing here is worth blocking or reporting on.
function refreshAsanaProjects(maxAgeHours) {
  const cmd = asanaCommand();
  if (!cmd) return;
  const file = asanaCacheFile();
  if (maxAgeHours) {
    try {
      if ((Date.now() - fs.statSync(file).mtimeMs) < maxAgeHours * 3600e3) return;
    } catch {}
  }
  const tokens = cmd.split(/\s+/);
  try {
    cp.execFile(tokens[0], [...tokens.slice(1), 'projects'], { timeout: 30000, maxBuffer: 1 << 22 }, (err, stdout) => {
      if (err) return;
      const list = parseAsanaProjects(stdout);
      if (!list.length) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list));
      } catch {}
    });
  } catch {}
}

// ── the routing table ────────────────────────────────────────────────────────

function clientsRoot() { return expandHome(cfg().get('clientsDir') || '~/clients'); }
function projectsRoot() { return expandHome(cfg().get('projectsDir') || '~/projects'); }

function dirsIn(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name);
  } catch { return []; }
}

// The directory for a client shortcode. A leading '#' is a quick-find marker, not part
// of the code, so both spellings are candidates — EEB has both, ~/clients/EEB holding
// its sessions and ~/clients/#EEB its long-running project folders. When a subfolder is
// named, the candidate that actually has it wins; otherwise the exact spelling does.
function clientDir(code, folders, sub) {
  const root = clientsRoot();
  const list = (folders || dirsIn(root)).filter((f) => f === code || f.replace(/^#/, '') === code);
  const candidates = list.sort((a, b) => (a === code ? -1 : b === code ? 1 : 0)).map((f) => path.join(root, f));
  if (sub) {
    const withSub = candidates.find((d) => fs.existsSync(path.join(d, sub)));
    if (withSub) return withSub;
  }
  return candidates[0] || null;
}

function clientName(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.agent', 'agent.json'), 'utf8')).client_name || ''; }
  catch { return ''; }
}

// The Asana projects that aren't a client's "<CODE> EDV", and where their work lives.
const HOUSE_PROJECTS = [
  { re: /^EEB EDV$/i, code: 'EEB', desc: 'our own business admin' },
  { re: /Hosting$/, code: 'EEB', sub: 'hosting', desc: 'our servers and hosting' },
  { re: /^infra$/i, repo: 'infra', desc: 'our own tooling, skills and this workstation' },
  { re: /AI Sandbox$/i, scratch: true, desc: 'throwaway tests of the Asana tooling' },
];

// One flat list of everywhere an entry can go. Only the primary "<CODE> EDV" project
// per client is offered, plus the house ones: sub-projects and retired "… old" ones
// read as perfectly plausible to a small model and would file work somewhere dead.
function listTargets() {
  const folders = dirsIn(clientsRoot());
  const out = [];
  for (const p of loadAsanaProjects()) {
    if (/\bold\b/i.test(p.name)) continue;
    const house = HOUSE_PROJECTS.find((h) => h.re.test(p.name));
    let dir = null, create = true, desc = '';
    if (house) {
      desc = house.desc;
      if (house.repo) { dir = path.join(projectsRoot(), house.repo); create = false; }
      else if (!house.scratch) {
        const c = clientDir(house.code, folders, house.sub);
        if (!c) continue;
        dir = house.sub ? path.join(c, house.sub) : c;
      }
    } else {
      // "BF EDV", plus the one irregular "WD - EDV".
      const m = p.name.match(/^([A-Z0-9]+)\s+(?:-\s+)?EDV$/);
      if (!m) continue;
      dir = clientDir(m[1], folders);
      if (!dir) continue;
      // Shortcodes are opaque (BB, RAHR, 2W), so the company name goes to the model
      // too — matching on "BERGMANN" is far safer than on "BB".
      desc = clientName(dir) || `client ${m[1]}`;
    }
    out.push({ id: `asana:${p.gid}`, name: p.name, gid: p.gid, dir, create, desc });
  }
  const taken = new Set(out.map((t) => t.dir).filter(Boolean));
  for (const name of dirsIn(projectsRoot())) {
    const dir = path.join(projectsRoot(), name);
    if (taken.has(dir)) continue;   // 'infra' is already in as its Asana project
    out.push({ id: `repo:${name}`, name, dir, create: false, desc: 'local dev project — session runs in the repo' });
  }
  return out;
}

function findTarget(id) {
  const want = String(id || '').trim().toLowerCase();
  if (!want || want === 'none') return null;
  return listTargets().find((t) => t.id.toLowerCase() === want) || null;
}

// Ask a cheap model, in one headless call (`claude -p`, so it reuses the CLI's own
// auth — no API key to manage), for what the entry is, where it belongs and a two-word
// folder name — all three in one round trip, so intent detection costs nothing on top
// of the naming call that already ran. cwd is a temp dir so the call doesn't drag in a
// project's CLAUDE.md. Resolves to a bare scratch plan on any failure or timeout.
function generateSessionPlan(question) {
  return new Promise((resolve) => {
    const targets = listTargets();
    const none = { slug: '', kind: 'session', target: null };
    // Asana projects get a line each — the client name is what makes an opaque
    // shortcode matchable. Repos are just names, on one line: spelling out "local dev
    // project" 58 times cost more latency than it ever bought in accuracy.
    const asana = targets.filter((t) => t.id.startsWith('asana:'));
    const repos = targets.filter((t) => t.id.startsWith('repo:'));
    const prompt = [
      'Route one entry from a "New Task" box.',
      '',
      'Entry:', question, '',
      'Asana projects — "<id> — <project> — <client or subject>":',
      ...asana.map((t) => `${t.id} — ${t.name} — ${t.desc}`),
      '',
      'Local dev repos, id is "repo:<name>":',
      repos.map((t) => t.name).join(', '),
      '',
      'Reply with ONLY a JSON object, no prose, no code fence:',
      '{"kind":"asana"|"email"|"session","target":"<id>"|"none","slug":"<two words>"}',
      '',
      'Rules:',
      '- kind "asana": something to be filed as a task or remembered — a to-do, a reminder,',
      '  a note to follow up. Often written as "asana <subject>".',
      '- kind "email": a mail to be written to somebody. Often written as "email <subject>",',
      '  or names a recipient ("an Herrn Wagner", "reply to ...", an address).',
      '- kind "session": actual work to do right now — a question, a bug, a change to make.',
      '- target must be an id from the lists above, copied verbatim, or "none".',
      '- An "asana" or "email" entry belongs to the asana: target whose client or subject it',
      '  is about — that is the Asana project it will be filed in.',
      '- A "session" entry belongs to a repo: target when it names one, otherwise to the',
      '  asana: target for the client it is about.',
      '- Shortcodes that merely look alike (RAH vs RAHR, PR vs PRX) are unrelated clients.',
      '  Never guess from a resemblance — prefer "none".',
      '- slug: exactly two lowercase words joined by a hyphen, summarising the entry.',
    ].join('\n');
    const tokens = (cfg().get('claudeCommand') || 'claude').trim().split(/\s+/);
    let child;
    try {
      child = cp.execFile(
        tokens[0],
        [
          ...tokens.slice(1), '-p', prompt, '--model', titleModel(),
          // This call classifies one line of text: it has no use for MCP servers,
          // hooks or tools, and booting them cost ~2.5s of the wait (measured).
          '--strict-mcp-config', '--settings', '{}',
        ],
        { cwd: os.tmpdir(), timeout: 40000, maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err ? none : parseSessionPlan(stdout, targets))
      );
    } catch { resolve(none); return; }
    child.on('error', () => resolve(none));
    // `claude -p` reads stdin for piped input and waits on it; execFile leaves the
    // pipe open, so without this the call stalls until the timeout every time.
    try { child.stdin.end(); } catch {}
  });
}

// A target only counts if it matches one we actually offered — a model that invents or
// misremembers a shortcode must degrade to the scratch folder, never write into some
// other client's directory.
function parseSessionPlan(stdout, targets) {
  const out = { slug: '', kind: 'session', target: null };
  const m = String(stdout || '').match(/\{[\s\S]*\}/);
  if (!m) return out;
  let obj; try { obj = JSON.parse(m[0]); } catch { return out; }
  out.slug = sanitiseSlug(obj.slug);
  const kind = String(obj.kind || '').trim().toLowerCase();
  if (kind === 'asana' || kind === 'email') out.kind = kind;
  // The id as asked for, but also the shapes the model reaches for on its own: a bare
  // gid, or a bare repo/project name. Anything that doesn't resolve to a target we
  // actually offered degrades to the scratch folder — a misremembered shortcode must
  // never write into some other client's directory.
  const want = String(obj.target || '').trim().toLowerCase();
  out.target = want && want !== 'none'
    ? targets.find((t) => t.id.toLowerCase() === want)
      || targets.find((t) => t.gid === want)
      || targets.find((t) => t.name.toLowerCase() === want.replace(/^(asana|repo|project|client):/, ''))
      || null
    : null;
  return out;
}

function uniqueDir(dir) {
  if (!fs.existsSync(dir)) return dir;
  const parent = path.dirname(dir), base = path.basename(dir);
  let i = 2, cand;
  do { cand = path.join(parent, `${base}-${i++}`); } while (fs.existsSync(cand));
  return cand;
}

const KIND_LABEL = { asana: 'Asana task', email: 'Email', session: 'Session' };

// Turn the raw entry into the session's first prompt. A "session" entry is passed
// through untouched — it already says what it wants. The other two are the typing the
// box exists to save: the verb and the destination are stated here instead.
function decoratePrompt(q, kind, target) {
  if (kind === 'asana') {
    const where = target && target.gid ? `Asana project "${target.name}" (${target.gid})` : 'the right Asana project';
    return [
      `Create an Asana task in ${where}, following the conventions in CLAUDE.md.`,
      'Search that project for an existing task on this first — if there is one, comment there instead.',
      'Report the task link when done.',
      '', 'Task:', q,
    ].join('\n');
  }
  if (kind === 'email') {
    const about = target ? ` It concerns ${target.desc || target.name}.` : '';
    return [
      `Draft this email with the email-writing skill, then show it and wait for approval — nothing is sent unprompted.${about}`,
      '', 'Mail:', q,
    ].join('\n');
  }
  return q;
}

function scratchTarget(slug) {
  return { id: 'none', name: 'Scratch', dir: path.join(expandHome(cfg().get('scratchDir') || '~/tasks'), slug), create: true, desc: 'unscoped scratch folder' };
}

// Where the session actually runs. A client or house target is a home for many
// sessions, so each entry gets its own slug subfolder; a repo target IS the workspace.
function targetDir(target, slug) {
  if (!target || !target.dir) return scratchTarget(slug).dir;
  return target.create ? path.join(target.dir, slug) : target.dir;
}

// Start a session whose first prompt is the user's entry, in the folder the Asana
// project (or repo) it was routed to implies. The proposal is shown in the box itself
// and confirmed there: shortcodes are easy to confuse and a wrong guess would write
// into another client's directory, so a match is never assumed.
async function askClaudeSession(question, io) {
  const q = String(question || '').trim();
  if (!q) return;
  // refocus: put the cursor back in the box on the way to idle. Right after a
  // cancellation that is what the user wants; right after a launch it would steal
  // focus from the terminal the session just opened in.
  const state = (s, refocus) => { try { io && io.state && io.state(s, refocus); } catch {} };
  state('naming');
  refreshAsanaProjects(12);
  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Claude: routing task…' },
    () => generateSessionPlan(q)
  );
  const slug = plan.slug || timestampName();
  let kind = plan.kind;
  let target = plan.target || scratchTarget(slug);

  for (;;) {
    const reply = await io.propose({
      kind,
      kindLabel: KIND_LABEL[kind],
      target: target.name,
      dir: shortHome(targetDir(target, slug)),
    });
    if (!reply || reply.type === 'cancel') { state('idle', true); return; }
    // Tab cycles the intent in the box, so any reply can carry a changed one — including
    // the one that only asks for the folder picker.
    if (reply.kind && KIND_LABEL[reply.kind]) kind = reply.kind;
    if (reply.type !== 'pickTarget') break;
    const picked = await pickTarget(slug);
    if (picked) target = picked;
  }

  const dir = target.create ? uniqueDir(targetDir(target, slug)) : target.dir;
  if (target.create) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      state('idle', true);
      vscode.window.showErrorMessage(`Claude Code Helper: could not create ${dir} — ${e.message}`);
      return;
    }
  }
  state('launching');
  let started = false;
  try {
    started = !!(await launchClaude(
      { path: dir, label: path.basename(dir) }, false,
      { skipNamePrompt: true, initialPrompt: decoratePrompt(q, kind, target) }
    ));
  } finally {
    state('idle', !started);
  }
}

// The override behind Shift+Tab: the full routing table, filterable, scratch first.
async function pickTarget(slug) {
  const scratch = scratchTarget(slug);
  const items = [scratch, ...listTargets()].map((t) => ({
    label: `$(folder) ${t.name}`,
    description: shortHome(targetDir(t, slug)),
    detail: t.desc,
    target: t,
  }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Where does this belong?', matchOnDetail: true });
  return pick ? pick.target : null;
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

// A webview view is the only way to get a real, always-visible text field in the
// sidebar — tree views can't host input. Enter starts a scratch session with the
// typed text as the first prompt; Shift+Enter adds a newline.
class AskViewProvider {
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this._html(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      const post = (m) => { try { view.webview.postMessage(m); } catch {} };
      if (msg.type === 'ask') {
        askClaudeSession(msg.text, {
          state: (s, refocus) => post({ type: 'state', state: s, refocus: !!refocus }),
          // The proposal is a question to the box: it resolves when the user accepts
          // it, changes the intent, asks for the folder picker, or cancels.
          propose: (p) => new Promise((resolve) => { this._answer = resolve; post({ type: 'propose', ...p }); }),
        });
        return;
      }
      if (this._answer && (msg.type === 'confirm' || msg.type === 'cancel' || msg.type === 'pickTarget')) {
        const answer = this._answer;
        this._answer = null;
        answer(msg);
      }
    });
  }
  _html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 6px 8px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  textarea {
    width: 100%; box-sizing: border-box; resize: none; min-height: 46px; max-height: 140px;
    padding: 4px 6px; font-family: inherit; font-size: inherit; line-height: 1.4;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  textarea:disabled { opacity: .6; }
  textarea[readonly] { opacity: .8; }
  #hint { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; min-height: 15px; }
  /* The routing proposal: intent and destination on one line, so accepting it is a
     glance and an Enter rather than a dialog. */
  #plan { margin-top: 4px; font-size: 11px; display: none; }
  #plan.on { display: block; }
  #kind { color: var(--vscode-textLink-foreground); font-weight: 600; }
  #dest { color: var(--vscode-foreground); }
  #dir { color: var(--vscode-descriptionForeground); word-break: break-all; }
  /* Indeterminate bar, VS Code's own: a slice sliding across a dim track. Naming
     takes ~10s, so the wait needs to look like progress, not like a hang. */
  #bar { height: 2px; margin-top: 4px; overflow: hidden; display: none; }
  #bar.on { display: block; }
  #bar > div { width: 40%; height: 100%; background: var(--vscode-progressBar-background); animation: slide 2s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
</style></head><body>
<textarea id="q" rows="2" placeholder="Ask Claude…"></textarea>
<div id="bar"><div></div></div>
<div id="plan">→ <span id="kind"></span> · <span id="dest"></span><br><span id="dir"></span></div>
<div id="hint">Enter to start a session · Shift+Enter for a new line</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const hint = document.getElementById('hint');
  const bar = document.getElementById('bar');
  const plan = document.getElementById('plan');
  const kindEl = document.getElementById('kind');
  const destEl = document.getElementById('dest');
  const dirEl = document.getElementById('dir');
  const IDLE = 'Enter to start a session · Shift+Enter for a new line';
  const CONFIRM = 'Enter start · Tab intent · Shift+Tab folder · Esc cancel';
  const KINDS = ['asana', 'email', 'session'];
  const KIND_LABEL = { asana: 'Asana task', email: 'Email', session: 'Session' };
  // Non-null exactly while a routing proposal is on screen; it is also the intent
  // that will be sent back, so Tab can cycle it without another round trip.
  let planKind = null;
  const clearPlan = () => { planKind = null; plan.classList.remove('on'); q.readOnly = false; };
  const answer = (msg) => { clearPlan(); vscode.postMessage(msg); };
  let tick = null, t0 = 0, label = '';
  const stopTick = () => { if (tick) { clearInterval(tick); tick = null; } };
  // Elapsed seconds alongside the bar — a concrete number reads as "still working"
  // far better than a spinner alone once the wait passes a few seconds.
  const startTick = (text) => {
    label = text;
    if (!tick) { t0 = Date.now(); tick = setInterval(paint, 1000); }
    paint();
  };
  const paint = () => { hint.textContent = label + ' ' + Math.round((Date.now() - t0) / 1000) + 's'; };
  const grow = () => { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 140) + 'px'; };
  q.addEventListener('input', grow);
  q.addEventListener('keydown', (e) => {
    if (planKind) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); answer({ type: 'confirm', kind: planKind }); }
      else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        planKind = KINDS[(KINDS.indexOf(planKind) + 1) % KINDS.length];
        kindEl.textContent = KIND_LABEL[planKind];
      }
      else if (e.key === 'Tab') { e.preventDefault(); answer({ type: 'pickTarget', kind: planKind }); }
      else if (e.key === 'Escape') { e.preventDefault(); answer({ type: 'cancel' }); }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'ask', text });
  });
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'propose') {
      stopTick();
      bar.classList.remove('on');
      planKind = m.kind;
      kindEl.textContent = m.kindLabel;
      destEl.textContent = m.target;
      dirEl.textContent = m.dir;
      plan.classList.add('on');
      hint.textContent = CONFIRM;
      // Readonly rather than disabled: a disabled textarea can't take focus, and the
      // proposal is answered with keys typed at this box.
      q.disabled = false;
      q.readOnly = true;
      q.focus();
      return;
    }
    if (m.type !== 'state') return;
    clearPlan();
    const busy = m.state !== 'idle';
    q.disabled = busy;
    bar.classList.toggle('on', busy);
    if (m.state === 'naming') startTick('Routing task…');
    else if (m.state === 'launching') startTick('Starting Claude…');
    // Focus only when the extension says nothing started. A launch ends with the new
    // session's terminal focused, and focusing this textarea would pull the cursor
    // straight back out of it — the box would swallow the first thing typed at Claude.
    else { stopTick(); hint.textContent = IDLE; q.value = ''; grow(); if (m.refocus) q.focus(); }
  });
</script></body></html>`;
  }
}

// ─── asana task lookup ───────────────────────────────────────────────────────
//
// Which Asana task, if any, a session belongs to. The bridge's index (∪ our
// history) is the only source: it records a `permalink` per session id and per
// working dir, so a hit is recorded fact, not inference — nothing is read out of
// transcript contents, and a session with no entry simply gets no link.

function asanaTasks() {
  return agentSessions().filter((e) => e && e.permalink);
}

// Session id first: it is exact. The working dir is the fallback for terminals we
// can't tie to an id (a window reload empties the id→terminal map) — safe because
// the bridge gives every task its own directory; newest entry wins if a dir was
// reused. Pass `entries` to resolve a whole tree render off one index read.
function asanaTaskFor(sessionId, dir, entries) {
  const list = entries || asanaTasks();
  if (sessionId) {
    const hit = list.find((e) => e.sessionId === sessionId);
    if (hit) return hit;
  }
  if (!dir) return null;
  const stamp = (e) => Date.parse(e.resumedAt || e.createdAt || '') || 0;
  return list.filter((e) => e.dir === dir).sort((a, b) => stamp(b) - stamp(a))[0] || null;
}

function openAsanaTask(entry) {
  if (!entry || !entry.permalink) {
    vscode.window.showInformationMessage('No Asana link recorded for this session.');
    return;
  }
  vscode.env.openExternal(vscode.Uri.parse(entry.permalink));
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

// Reverse of sessionTerminals: the session id this window attached in a terminal.
function sessionIdForTerminal(terminal) {
  for (const [id, t] of sessionTerminals) if (t === terminal) return id;
  return null;
}

function terminalAsanaTask(terminal, cwd, entries) {
  return asanaTaskFor(sessionIdForTerminal(terminal), cwd && cwd.fsPath, entries);
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
    const tasks = asanaTasks(); // one index read for the whole render
    const out = [];
    for (const t of vscode.window.terminals) {
      const cwd = getTerminalCwd(t);
      if (!cwd && !showWithoutCwd) continue;
      const isActive = t === active;
      const task = terminalAsanaTask(t, cwd, tasks);
      const item = new vscode.TreeItem(terminalDisplayName(t), vscode.TreeItemCollapsibleState.None);
      item.description = cwd ? shortHome(cwd.fsPath) : 'no cwd';
      item.tooltip = buildTerminalTooltip(t, cwd, task);
      // Only rows with a recorded task get the Asana button.
      item.contextValue = task ? 'terminalAsana' : 'terminal';
      item.iconPath = new vscode.ThemeIcon(
        'terminal',
        isActive ? new vscode.ThemeColor('terminal.ansiGreen') : new vscode.ThemeColor('disabledForeground')
      );
      const node = { terminal: t, cwd, task, treeItem: item };
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
// The CLI's own session registry: `claude agents --json` reports every live
// session with a real state — busy / idle / waiting / blocked — where this
// extension previously had to infer liveness from a socket file plus a `ps`
// scan and could only ever answer yes/no. Measured 2026-08-08: the CLI knew
// about 8 live sessions while the bridge's hand-kept index held 2 and no state
// at all.
//
// Cached for 2s because the tree asks per row. Returns null (NOT an empty map)
// when the CLI cannot be reached, so callers can tell "nothing is running" from
// "we do not know" and fall back to the old evidence instead of reporting every
// session dead.
let claudeAgentsCache = { at: 0, map: null };
function claudeAgentsMap() {
  if (claudeAgentsCache.map && Date.now() - claudeAgentsCache.at < 2000) return claudeAgentsCache.map;
  try {
    const bin = cfg().get('claudeCommand') || 'claude';
    const out = cp.execFileSync(bin, ['agents', '--json'],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    const list = JSON.parse(out);
    const map = new Map();
    for (const a of Array.isArray(list) ? list : []) {
      if (!a.sessionId) continue;
      map.set(a.sessionId, {
        sessionId: a.sessionId,
        pid: a.pid || null,
        cwd: a.cwd || '',
        kind: a.kind || 'interactive',
        // interactive agents carry `status`, background ones carry `state`
        status: a.status || a.state || 'unknown',
        waitingFor: a.waitingFor || null,
        startedAt: a.startedAt || null,
      });
    }
    claudeAgentsCache = { at: Date.now(), map };
    return map;
  } catch {
    return null; // unknown — never mistake this for "nothing is running"
  }
}

function liveSessionIds() {
  const ids = new Set();
  // The CLI is authoritative and catches sessions the ps regex cannot see.
  const agents = claudeAgentsMap();
  if (agents) for (const id of agents.keys()) ids.add(id);
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

// Sockets that still have a dtach process behind them. The socket *file* outlives
// its master — it sits in ~/.claude/dtach on disk, so a reboot or a SIGKILLed
// master leaves the file there and mere existence keeps reporting a long-dead
// session as 🟢 running. Clicking one then hands the terminal an attach that can
// only answer `dtach: …: Connection refused` (seen after the box rebooted
// overnight, 2026-07-30). Liveness is a *listener*, so ask ps who is holding the
// socket. Matched on comm=dtach so the shells, pkills and launch lines that merely
// mention the path don't count; a `dtach -a` client counts, since a client can
// only exist while its master does. Cached briefly — the tree asks per row.
let dtachLiveSockets = { at: 0, set: null };
function liveDtachSocketPaths() {
  if (dtachLiveSockets.set && Date.now() - dtachLiveSockets.at < 2000) return dtachLiveSockets.set;
  const set = new Set();
  try {
    const out = cp.execSync('ps -e -o comm=,args=', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      if (!/^dtach\s/.test(line)) continue;
      for (const m of line.matchAll(/\S+\.sock/g)) set.add(m[0]);
    }
  } catch { return null; } // ps unavailable — callers fall back to file existence
  dtachLiveSockets = { at: Date.now(), set };
  return set;
}

// The dtach socket a live session can be re-attached through, or null. Only
// dtach launches are grabbable cross-window from Recent Sessions: tmux launches
// live in the agent index (reachable in any window via Agent Sessions), and
// plain-terminal launches have no master to attach to.
function sessionDtachSocket(id) {
  const sock = path.join(dtachSocketDir(), id + '.sock');
  try {
    if (!fs.existsSync(sock)) return null;
    const live = liveDtachSocketPaths();
    return !live || live.has(sock) ? sock : null;
  } catch { return null; }
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
      // Resolve Asana tasks once per load rather than per rendered row.
      const tasks = asanaTasks();
      const groups = new Map();
      for (const s of sessions) {
        s.asana = asanaTaskFor(s.id, null, tasks);
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
    // (Delete Session) don't apply to a session that's still running. The
    // `Asana` suffix is what shows the task button — only on rows the bridge
    // index knows a task for.
    it.contextValue = (s.live ? 'sessionLive' : 'session') + (s.asana ? 'Asana' : '');
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
// The bridge spawns each picked-up task as an INTERACTIVE claude in a detached
// session and records it in an index file. These sessions run in the background
// — outside VS Code — so they never appear in "Running Sessions". This view
// surfaces them: 🟢 live ones attach (reconnect to the running process),
// ⚫ ended ones resume from the transcript.
//
// Two backends coexist. The bridge (and this extension's own useDtach launches)
// use a per-session `dtach` socket keyed by session id; the extension's useTmux
// launches use a named tmux session on the agent socket and carry a `tmuxName`.
// An entry's `tmuxName` is what tells the two apart — bridge entries have none.

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

// Is the session behind this entry still running?
//
// The CLI is asked first and settles it for every kind of session — tmux,
// dtach, or the bridge rewrite's headless `claude -p --resume` runs, which have
// no socket and no tmux name at all and would otherwise render ⚫ ended while
// actively working. Only when the CLI is unreachable do we fall back to the old
// evidence, which remains correct for what it covers.
function agentLive(entry) {
  if (!entry) return false;
  const agents = claudeAgentsMap();
  if (agents && entry.sessionId && agents.has(entry.sessionId)) return true;
  if (entry.tmuxName) return tmuxAlive(entry.tmuxName);
  if (entry.sessionId && sessionDtachSocket(entry.sessionId)) return true;
  // A CLI answer we trust and that does not mention this session means ended —
  // but only if we actually got one.
  return false;
}

// The real state behind a live row: 'busy' | 'idle' | 'waiting' | 'blocked'.
// Null when the CLI is unreachable or does not know the session, in which case
// callers fall back to the plain live/ended pair.
function agentStatus(entry) {
  const agents = claudeAgentsMap();
  const a = agents && entry && entry.sessionId ? agents.get(entry.sessionId) : null;
  return a ? a.status : null;
}
const AGENT_STATUS_GLYPH = {
  busy: '🟢', idle: '🔵', waiting: '🟠', blocked: '🔴', unknown: '🟢',
};
function agentStatusGlyph(entry, live) {
  if (!live) return '⚫';
  return AGENT_STATUS_GLYPH[agentStatus(entry)] || '🟢';
}

// Bridge sessions the index does not know about.
//
// asana-bridge2 deliberately keeps no hand-maintained index — its whole point
// is that `claude agents --json` is the truth — so without this the Agent
// Sessions pane would simply not show its sessions. Any live session whose cwd
// holds an `.asana-claude.json` marker is a bridge task session, and the marker
// carries everything a row needs.
function discoveredAgentSessions() {
  const agents = claudeAgentsMap();
  if (!agents) return [];
  const out = [];
  for (const a of agents.values()) {
    if (!a.cwd) continue;
    let marker;
    try { marker = JSON.parse(fs.readFileSync(path.join(a.cwd, '.asana-claude.json'), 'utf8')); }
    catch { continue; }
    out.push({
      sessionId: a.sessionId,
      dir: a.cwd,
      displayName: path.basename(a.cwd),
      taskGid: marker.taskGid || null,
      source: 'bridge2',
      createdAt: marker.createdAt || (a.startedAt ? new Date(a.startedAt).toISOString() : null),
    });
  }
  return out;
}

// Our own history of agent sessions, kept beside the bridge's index. The index is
// a LIVE registry, not a log: the bridge's reapEnded() deletes an entry the moment
// its socket goes away, so a finished session would vanish from this view within a
// minute of ending — taking the "⚫ ended ones resume from the transcript" half of
// the view with it. Everything we ever see in the index is mirrored here and kept
// serving after the bridge drops it. The index stays read-mostly: the bridge owns it.
function agentHistoryFile() {
  const index = agentIndexFile();
  // Deliberately not a prefix of the index file name — the watcher in activate()
  // refreshes on anything starting with it, and this file is written from inside
  // that refresh.
  return path.join(path.dirname(index), 'agent-sessions-history.json');
}

function readAgentHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(agentHistoryFile(), 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch { return []; }
}

function writeAgentHistory(sessions) {
  const file = agentHistoryFile();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { console.error(`Claude Code Helper: failed to write ${file} — ${e.message}`); }
}

// Index ∪ history, index winning on conflicts (it carries the fresher resumedAt).
// Ended entries age out on the same clock as Recent Sessions; a running one never
// ages out. Rewrites the history file only when the merge actually changed it.
function agentSessions() {
  const history = readAgentHistory();
  const byId = new Map();
  for (const e of history) if (e && e.sessionId) byId.set(e.sessionId, e);
  for (const e of readAgentIndex()) {
    if (e && e.sessionId) byId.set(e.sessionId, { ...byId.get(e.sessionId), ...e });
  }
  // Sessions no index knows about — asana-bridge2 keeps none by design. Merged
  // after the index so a session present in both keeps the index's richer
  // fields, and folded into history like any other, so the row survives as
  // ⚫ ended once the run finishes.
  for (const e of discoveredAgentSessions()) {
    byId.set(e.sessionId, { ...e, ...byId.get(e.sessionId) });
  }
  const maxAgeMs = (cfg().get('sessionsMaxAgeDays', 7) || 7) * 24 * 3600 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const merged = [...byId.values()].filter((e) => {
    if (agentLive(e)) return true;
    const seen = Date.parse(e.resumedAt || e.createdAt || '');
    return !Number.isFinite(seen) || seen >= cutoff;
  });
  const before = JSON.stringify(history);
  const after = JSON.stringify(merged);
  if (before !== after) writeAgentHistory(merged);
  return merged;
}

// Forget an agent session: drop it from our history, and from the bridge's index
// too when it is no longer running (a live entry is the bridge's — deleting it
// would make the bridge believe the task has no session and spawn a second one).
function forgetAgentSession(entry) {
  if (!entry || !entry.sessionId) return;
  writeAgentHistory(readAgentHistory().filter((s) => s.sessionId !== entry.sessionId));
  if (agentLive(entry)) return;
  const index = readAgentIndex();
  const kept = index.filter((s) => s.sessionId !== entry.sessionId);
  if (kept.length !== index.length) writeAgentIndex(kept);
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
  metaLines.push(entry.tmuxName
    ? `🖥️ \`tmux -L ${agentSocket()} attach -t ${entry.tmuxName}\``
    : `🖥️ \`dtach -a ${path.join(dtachSocketDir(), entry.sessionId + '.sock')} -E -z -r winch\``);
  metaLines.push(`🆔 \`${entry.sessionId}\``);
  const st = live ? agentStatus(entry) : null;
  const a = live && claudeAgentsMap() ? claudeAgentsMap().get(entry.sessionId) : null;
  metaLines.push(live
    ? `${agentStatusGlyph(entry, true)} running${st && st !== 'unknown' ? ` — ${st}` : ''}` +
      (a && a.waitingFor ? ` (${a.waitingFor})` : '')
    : '⚫ ended');
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
    this._filter = '';
    this.view = null; // set after createTreeView so we can show the match count
  }
  get filter() { return this._filter; }
  setFilter(q) {
    const next = (q || '').trim();
    if (next === this._filter) return;
    this._filter = next;
    vscode.commands.executeCommand('setContext', 'claudeHelper.agentSessionsFiltered', !!next);
    this.refresh();
  }
  refresh() { this._em.fire(); }
  _matches(entry, q) {
    let meta = null;
    try { meta = readSessionMeta(agentSessionFile(entry)); } catch {}
    const hay = [
      entry.displayName, entry.dir, entry.sessionId, entry.permalink,
      meta && meta.title, meta && meta.summary, meta && meta.firstUserMsg,
    ].filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  }
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
    const isAsana = e.source === 'asana' || e.source === 'bridge2' || !!e.taskGid;
    // The glyph carries the CLI's real state now, not a live/ended boolean:
    // 🟢 busy · 🔵 idle · 🟠 waiting · 🔴 blocked · ⚫ ended.
    item.description = isAsana
      ? `${agentStatusGlyph(e, live)} ${shortHome(e.dir)}`
      : shortHome(e.dir);
    let meta = null;
    try { meta = readSessionMeta(agentSessionFile(e)); } catch {}
    item.tooltip = buildAgentTooltip(e, live, meta);
    // …Task suffix = a recorded Asana permalink, which is what shows the button.
    item.contextValue = (live ? 'agentSessionLive' : 'agentSessionEnded') + (e.permalink ? 'Task' : '');
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
    const all = agentSessions();
    const q = this._filter.toLowerCase();
    const entries = q ? all.filter((e) => this._matches(e, q)) : all;
    if (this.view) {
      this.view.message = q
        ? `Filter “${this._filter}” — ${entries.length} of ${all.length} session${all.length === 1 ? '' : 's'}`
        : undefined;
    }
    const nodes = entries.map((entry) => ({ entry, live: agentLive(entry) }));
    // live first, then most-recently started
    nodes.sort((a, b) => (b.live - a.live) || (String(b.entry.createdAt).localeCompare(String(a.entry.createdAt))));
    return nodes;
  }
}

function attachAgentSession(node) {
  if (!node || !node.entry) return;
  const e = node.entry;
  // Re-checked at click time, not taken from render time: the session may have
  // ended in the meantime, in which case resuming from the transcript is correct.
  if (!agentLive(e)) {
    vscode.window.showWarningMessage(`Agent session "${e.displayName}" is no longer running — resuming instead.`);
    return resumeAgentSession(node);
  }
  const name = `▶ ${e.displayName}`;
  let terminal = vscode.window.terminals.find((t) => t.name === name);
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd: fs.existsSync(e.dir) ? e.dir : undefined });
  terminal.show();
  if (e.tmuxName) {
    terminal.sendText(`tmux -L ${agentSocket()} attach -t ${e.tmuxName}`);
  } else {
    // Attach only — no `dtach -n`, and above all no rewrite of the session's
    // .run-claude.sh: the master is the bridge's, still running its own runner.
    const socket = path.join(dtachSocketDir(), e.sessionId + '.sock');
    terminal.sendText(` ${dtachStealCmd(socket)}; ${dtachAttachCmd(socket)}`);
  }
  registerSessionTerminal(e.sessionId, terminal);
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
  forgetAgentSession(node.entry);
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
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'claudeHelper.ask', new AskViewProvider(), { webviewOptions: { retainContextWhenHidden: true } }
  ));
  refreshAsanaProjects(12);   // warm the New Task routing table; never blocks a submit

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
  agentProvider.view = agentView;
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
  reg('claudeHelper.searchAgentSessions', () => {
    const box = vscode.window.createInputBox();
    box.title = 'Search Agent Sessions';
    box.placeholder = 'Filter by session name, directory or summary…';
    box.value = agentProvider.filter;
    box.onDidChangeValue((v) => agentProvider.setFilter(v));
    box.onDidAccept(() => box.hide());
    box.onDidHide(() => box.dispose());
    box.show();
  });
  reg('claudeHelper.clearAgentSessionsSearch', () => agentProvider.setFilter(''));
  reg('claudeHelper.attachAgentSession', (node) => attachAgentSession(node));
  reg('claudeHelper.resumeAgentSession', (node) => resumeAgentSession(node));
  reg('claudeHelper.openAgentSessionFolder', (node) => {
    if (!node || !node.entry) return;
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.entry.dir), { forceNewWindow: true });
  });
  reg('claudeHelper.openAgentTask', (node) => openAsanaTask(node && node.entry));
  // Same link from the other two views. Both re-resolve at click time instead of
  // trusting the render-time node: the index moves on (a session ends, a terminal
  // gets reused for another task) while the tree sits there.
  reg('claudeHelper.openTerminalTask', (node) => {
    if (!node || !node.terminal) return;
    openAsanaTask(terminalAsanaTask(node.terminal, node.cwd) || node.task);
  });
  reg('claudeHelper.openSessionTask', (node) => {
    if (!node || node.kind !== 'session') return;
    openAsanaTask(asanaTaskFor(node.session.id) || node.session.asana);
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
    const e = node.entry;
    if (e.tmuxName) {
      try { cp.spawnSync('tmux', ['-L', agentSocket(), 'kill-session', '-t', e.tmuxName]); } catch {}
    } else if (e.sessionId) {
      // Same reach as the bridge's own killSession: the session id appears both in
      // the dtach master's socket-path arg and in claude's --session-id, so one
      // pattern takes down master and process; then drop the socket, which is what
      // both sides read as "dead".
      try { cp.spawnSync('pkill', ['-f', e.sessionId]); } catch {}
      try { fs.unlinkSync(path.join(dtachSocketDir(), e.sessionId + '.sock')); } catch {}
    }
    // Killed, not forgotten: the row stays as ⚫ ended and is still resumable from
    // its transcript. "Remove from List" is the gesture that drops it for good.
    agentProvider.refresh();
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
