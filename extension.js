const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const https = require('https');

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
  if (created) { moveTerminalTabToEnd(); registerTabState(terminal, tabId); }
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
    if (agentProvider) { try { agentProvider.refresh(); } catch {} }
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
  if (isNewMaster) registerTabState(terminal, tabId);
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
  // Register unconditionally, including on a reattach (wasLive): when !wasLive,
  // tabId genuinely is this terminal's shell's env, so registering it is exactly
  // correct and is what the decoration provider's fast path will read for the
  // rest of this window's life. When wasLive, tabId was never actually put into
  // this terminal's env (see the opts.env gate above) — registering it anyway
  // is a harmless no-op: the fast path returns an id no hook ever writes to, so
  // it resolves to no decoration, exactly as if nothing were registered at all
  // (falling through would hit the same terminal's own /proc/<pid>/environ,
  // which — for the same reason — has nothing either).
  registerTabState(terminal, tabId);
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

// ── the task we already have ─────────────────────────────────────────────────
//
// Half of what gets pasted into the box is the name of a task that already exists —
// an alert-spawned Asana task, a title copied out of the app. That name answers the
// routing question outright: the project it sits in IS the destination, and no amount
// of shortcode-and-company-name matching can beat it. "✨ 🔴 MP startpage publisher
// (moneyprofiler.de)" routed to nothing, because nothing in the table says SFF owns
// moneyprofiler.de — while five tasks by that exact name sat in SFF EDV.
//
// It also catches the duplicate: those five exist because every run created a task
// instead of commenting on the open one.

// The box is usually typed "asana <subject>" / "email <subject>". The verb is the box's
// grammar, not part of the task's name.
function asanaTaskQuery(q) {
  return String(q || '').trim().replace(/^(asana|email)\s+/i, '').trim();
}

// The other thing typed in front of a pasted task name is the client: "rah 4. Final Local
// Folders copy". That word is addressing, not part of the name, and leaving it in breaks
// the exact match that the whole lookup rests on — the entry then reaches the model as a
// bare string and gets matched on wordplay. Only a token that IS one of our shortcodes is
// dropped, and the original spelling stays a candidate, so a task genuinely named after a
// client still matches.
function asanaTaskNames(question, targets) {
  const base = asanaTaskQuery(question);
  const names = [base];
  const codes = new Set(HOUSE_PROJECTS.map((h) => h.code).filter(Boolean).map((c) => c.toUpperCase()));
  for (const t of targets) {
    const m = /^client:(.+)$/i.exec(t.id || '');
    if (m) codes.add(m[1].toUpperCase());
  }
  const lead = /^([A-Za-z0-9#]{2,6})\s+(\S.*)$/.exec(base);
  if (lead && codes.has(lead[1].replace(/^#/, '').toUpperCase())) names.push(lead[2].trim());
  // The search runs on the narrowest spelling: the shortcode is a word Asana has to match
  // somewhere, and the task's own name is the text most likely to come back verbatim.
  return { query: names[names.length - 1], names };
}

// A subtask carries no projects of its own — Asana files the parent and hangs the subtask
// off it — so read literally, every subtask belongs nowhere and was invisible here. Its
// home is the parent's project, which the search now returns in the same call.
function taskProjects(t) {
  if (t && Array.isArray(t.projects) && t.projects.length) return t.projects;
  const p = t && t.parent;
  return (p && Array.isArray(p.projects)) ? p.projects : [];
}

// House task names are prefixed "✨ " and often a severity dot, and a name pasted out of
// the app carries them while a name typed from memory does not. That decoration is ours,
// not part of what the task is called, so it is stripped from both sides.
function sameTaskName(a, b) {
  const norm = (s) => String(s || '')
    .replace(/^[\s✨🔴🟠🟡🟢⚠️️]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return norm(a) === norm(b) && norm(a).length > 0;
}

// Only an EXACT name match counts. `asana find` is a fuzzy search — it answers a
// three-word query with twenty loosely-related tasks — so anything less than verbatim
// would be the guessing the model already does, at the cost of a network call.
function matchAsanaTask(names, list, targets) {
  const resolved = [];
  for (const t of list) {
    if (!names.some((n) => sameTaskName(t && t.name, n))) continue;
    const projects = taskProjects(t);
    const target = targets.find((x) => x.gid && projects.some((p) => p && p.gid === x.gid));
    if (target) resolved.push({ task: t, target });
  }
  if (!resolved.length) return null;
  // The same name under two different clients is not evidence of anything. Giving up
  // hands the decision back to the model, which is where it started.
  if (resolved.some((r) => r.target !== resolved[0].target)) return null;
  // A completed task means the subject came round again and wants a new one filed in
  // the same project — only an open task is something to comment on.
  const open = resolved.find((r) => !r.task.completed);
  return { target: resolved[0].target, task: open ? open.task : null };
}

// Runs alongside the routing call, not after it: ~0.9s, which is inside what the model
// spends anyway. Any failure resolves to null and the model's answer stands.
function findAsanaTask(question, targets) {
  return new Promise((resolve) => {
    const cmd = asanaCommand();
    const { query, names } = asanaTaskNames(question, targets);
    // A handful of characters would match half the workspace under a fuzzy search, and
    // an exact hit on them would be a coincidence rather than a reference.
    if (!cmd || query.length < 8) return resolve(null);
    const tokens = cmd.split(/\s+/);
    let child;
    try {
      child = cp.execFile(
        tokens[0], [...tokens.slice(1), 'find', query, '--limit', '20', '--json'],
        { timeout: 15000, maxBuffer: 1 << 22 },
        (err, stdout) => {
          if (err) return resolve(null);
          let list; try { list = JSON.parse(String(stdout || '')); } catch { return resolve(null); }
          resolve(Array.isArray(list) ? matchAsanaTask(names, list, targets) : null);
        }
      );
    } catch { return resolve(null); }
    child.on('error', () => resolve(null));
  });
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

// `client_name` is what the IT Portal sync writes, but a hand-made agent.json spells it
// `name`, and one or two carry only `business`. Reading the one key left 12 of 68 clients
// described to the router as "client SFF" — a tautology in the one field that exists to
// make an opaque shortcode matchable.
function clientName(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '.agent', 'agent.json'), 'utf8'));
    return j.client_name || j.name || j.business || '';
  } catch { return ''; }
}

// The Asana projects that aren't a client's own, and where their work lives.
const HOUSE_PROJECTS = [
  { re: /^EEB EDV$/i, code: 'EEB', desc: 'our own business admin' },
  { re: /Hosting$/, code: 'EEB', sub: 'hosting', desc: 'our servers and hosting' },
  { re: /^infra$/i, repo: 'infra', desc: 'our own tooling, skills and this workstation' },
  { re: /AI Sandbox$/i, scratch: true, desc: 'throwaway tests of the Asana tooling' },
];

// The Asana project a client's work is filed in. Most are "<CODE> EDV", but plenty are
// not — SFC's only project is "SFC Websites", PCS's is a bare "PCS" — so a client is
// never keyed on that spelling; this only decides which project the task GETS FILED IN
// once the client is already known.
//
// Several projects can share a shortcode, so the primary one is preferred and a genuine
// tie gives up: "IR misc" and "IR magento" are both plausible and picking either is a
// guess that files work in the wrong place. Returning null is safe — the client is still
// a destination, and decoratePrompt then asks the session to choose the project.
function clientProject(code, projects) {
  const want = code.toUpperCase();
  // "WD - EDV" is the one irregular spelling; normalising it here keeps it a primary.
  const norm = (n) => n.toUpperCase().replace(/\s+-\s+/, ' ').trim();
  const cand = projects.filter((p) => !/\bold\b/i.test(p.name)
    && !HOUSE_PROJECTS.some((h) => h.re.test(p.name))
    && p.name.split(/\s+/)[0].toUpperCase() === want);
  return cand.find((p) => norm(p.name) === `${want} EDV`)
    || cand.find((p) => norm(p.name) === want)
    || (cand.length === 1 ? cand[0] : null);
}

// A repo can be an Asana project in its own right — ~/projects/healthboard and the
// project "Healthboard" are one thing under two names. Nothing recorded that link, so a
// repo target carried no gid, and the exact-task lookup only recognises a task whose
// project is one of the destinations: "Nährstoff Display" — a task sitting in Healthboard
// — matched nothing and was handed back to the model to route on wordplay.
//
// Only an exact name match counts, and a project already claimed by a client or house
// target is not up for grabs. A tie is dropped rather than guessed: filing work in the
// wrong project is worse than not finding it.
function repoProject(name, projects, used) {
  const want = name.trim().toLowerCase();
  const cand = projects.filter((p) => !used.has(p.gid)
    && !/\bold\b/i.test(p.name)
    && p.name.trim().toLowerCase() === want);
  return cand.length === 1 ? cand[0] : null;
}

// One flat list of everywhere an entry can go: every client, the house projects, and
// every local repo.
//
// Clients come from the ~/clients folders, NOT from the Asana project list. Keying them
// on a project named "<CODE> EDV" left 31 of 68 clients — SFC, PCS, PM, VS, IR, NANO …
// — with no destination at all, so the router could only answer "none" and their work
// landed in the scratch folder however clearly the entry named them. The folder is what
// a session actually needs, and it exists whether or not the project is spelled that way.
function listTargets() {
  const folders = dirsIn(clientsRoot());
  const projects = loadAsanaProjects();
  const out = [];
  for (const p of projects) {
    const house = HOUSE_PROJECTS.find((h) => h.re.test(p.name));
    if (!house || /\bold\b/i.test(p.name)) continue;
    let dir = null, create = true;
    if (house.repo) { dir = path.join(projectsRoot(), house.repo); create = false; }
    else if (!house.scratch) {
      const c = clientDir(house.code, folders, house.sub);
      if (!c) continue;
      dir = house.sub ? path.join(c, house.sub) : c;
    }
    out.push({ id: `asana:${p.gid}`, name: p.name, gid: p.gid, dir, create, desc: house.desc });
  }
  // A '#' prefix is a quick-find marker, not part of the code, so both spellings of a
  // client collapse onto the one directory clientDir() resolves.
  const houseCodes = new Set(HOUSE_PROJECTS.map((h) => h.code).filter(Boolean));
  for (const code of [...new Set(folders.map((f) => f.replace(/^#/, '')))].sort()) {
    if (houseCodes.has(code)) continue;   // EEB is already in as its house projects
    const dir = clientDir(code, folders);
    if (!dir || out.some((t) => t.dir === dir)) continue;
    const p = clientProject(code, projects);
    out.push({
      id: `client:${code}`,
      // The project name when there is one: it is what the model reads as the
      // destination, and what decoratePrompt quotes back to the session.
      name: p ? p.name : code,
      gid: p ? p.gid : '',
      dir,
      // A client folder is a home for many sessions, so each entry gets its own slug
      // subfolder under it — never the client root itself.
      create: true,
      // Shortcodes are opaque (BB, RAHR, 2W), so the company name goes to the model
      // too — matching on "BERGMANN" is far safer than on "BB".
      desc: clientName(dir) || `client ${code}`,
    });
  }
  const taken = new Set(out.map((t) => t.dir).filter(Boolean));
  const used = new Set(out.map((t) => t.gid).filter(Boolean));
  for (const name of dirsIn(projectsRoot())) {
    const dir = path.join(projectsRoot(), name);
    if (taken.has(dir)) continue;   // 'infra' is already in as its Asana project
    const p = repoProject(name, projects, used);
    if (p) used.add(p.gid);
    out.push({
      id: `repo:${name}`,
      name,
      gid: p ? p.gid : '',
      dir,
      create: false,
      desc: p ? `local dev project — its work is filed in Asana project "${p.name}"`
              : 'local dev project — session runs in the repo',
    });
  }
  return out;
}

function findTarget(id) {
  const want = String(id || '').trim().toLowerCase();
  if (!want || want === 'none') return null;
  return listTargets().find((t) => t.id.toLowerCase() === want) || null;
}

// The key for the routing calls, from the environment or, since the extension host
// doesn't inherit a login shell's env, from an env file. Never logged.
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const file = expandHome(cfg().get('apiKeyFile') || '~/.env');
    const m = fs.readFileSync(file, 'utf8').match(/^[ \t]*(?:export[ \t]+)?ANTHROPIC_API_KEY[ \t]*=[ \t]*(.+?)[ \t]*$/m);
    return m ? m[1].replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

// Routing is one small Haiku call. Through `claude -p` it took ~9s, almost all of it
// the CLI booting around a request the API answers in ~1.1s (both measured on the same
// prompt). So the API is the path, and the CLI stays as the fallback for when no key is
// configured or the request fails — it needs no key of its own.
async function askModel(prompt, system) {
  const key = apiKey();
  if (key) {
    const out = await askApi(prompt, key, system);
    if (out) return out;
  }
  return askModelCli(prompt, system);
}

function askApi(prompt, key, system) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: titleModel(),
      max_tokens: 200,
      // The CLI wraps these calls in a system prompt of its own; the API sends exactly
      // what it is given, and without one the model is markedly looser — the folder
      // matcher accepted a new-printer note as a continuation of a USB-copy folder.
      ...(system ? { system } : {}),
      // The API defaults to temperature 1, which the CLI does not. Left at the default
      // these calls get creative: the folder matcher started accepting a printer task
      // as a continuation of a USB-copy folder. Classification wants no creativity.
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    let req;
    try {
      req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 20000,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j && j.content && j.content[0] && j.content[0].text ? String(j.content[0].text) : '');
          } catch { resolve(''); }
        });
      });
    } catch { resolve(''); return; }
    req.on('error', () => resolve(''));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(''); });
    req.end(body);
  });
}

// ── the mail the entry points at ─────────────────────────────────────────────
//
// "email Cloudflare" is not a two-word subject, it is a pointer to a message sitting in
// the inbox — and everything that decides the destination (who sent it, which client
// they are) is in that message, not in the two words. Without dereferencing it the
// model is shown "Cloudflare" and a client list and routes it to nothing, correctly.
// The lookup reads the mailbox over IMAP (read-only) and maps the sender through
// client-emails.json, the same table that files a labelled mail into its project.
function mailLookupCommand() { return expandHome((cfg().get('mailLookupCommand') || '').trim()); }

function isMailEntry(q) { return /^email\s+\S/i.test(String(q || '').trim()); }

function findMail(question) {
  return new Promise((resolve) => {
    const cmd = mailLookupCommand();
    const subject = asanaTaskQuery(question);
    if (!cmd || !isMailEntry(question) || subject.length < 3) return resolve(null);
    const tokens = cmd.split(/\s+/);
    let child;
    try {
      child = cp.execFile(
        tokens[0], [...tokens.slice(1), subject],
        // Gmail's IMAP login + SELECT alone swings between 4 and 10s from here (measured
        // 2026-08-26); a timeout that sometimes drops the answer is worse than the wait.
        { timeout: 25000, maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err) return resolve(null);
          let m; try { m = JSON.parse(String(stdout || '')); } catch { return resolve(null); }
          resolve(m && m.subject ? m : null);
        }
      );
    } catch { return resolve(null); }
    child.on('error', () => resolve(null));
  });
}

// The client the mail's sender belongs to, as a routing target. A house code (EEB) has
// several projects and no single "client:" entry, so only real clients resolve here;
// the model still sees the sender and decides the rest.
function mailTarget(mail, targets) {
  const code = mail && mail.client ? String(mail.client).toUpperCase() : '';
  if (!code) return null;
  return targets.find((t) => t.id.toUpperCase() === `CLIENT:${code}`) || null;
}

function mailContext(mail) {
  if (!mail) return [];
  return [
    'The entry points at this mail in the inbox:',
    `From: ${mail.from}`,
    `Subject: ${mail.subject}`,
    `Date: ${mail.date}`,
    ...(mail.client ? [`Sender belongs to client: ${mail.client}`] : []),
    ...(mail.snippet ? [`Excerpt: ${mail.snippet}`] : []),
    '',
  ];
}

// cwd is a temp dir so the call doesn't drag in a project's CLAUDE.md, and MCP servers,
// hooks and tools stay unloaded — this classifies one line of text and has no use for
// any of them (worth ~2.5s of the CLI's boot, measured).
function askModelCli(prompt, system) {
  return new Promise((resolve) => {
    const tokens = (cfg().get('claudeCommand') || 'claude').trim().split(/\s+/);
    const text = system ? `${system}\n\n${prompt}` : prompt;
    let child;
    try {
      child = cp.execFile(
        tokens[0],
        [...tokens.slice(1), '-p', text, '--model', titleModel(), '--strict-mcp-config', '--settings', '{}'],
        { cwd: os.tmpdir(), timeout: 40000, maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err ? '' : String(stdout || ''))
      );
    } catch { resolve(''); return; }
    child.on('error', () => resolve(''));
    // `claude -p` reads stdin for piped input and waits on it; execFile leaves the
    // pipe open, so without this the call stalls until the timeout every time.
    try { child.stdin.end(); } catch {}
  });
}

// What the entry is, where it belongs and a two-word folder name in one round trip, then
// whether it continues work that already has a folder. Degrades to a bare scratch plan
// on any failure or timeout.
async function generateSessionPlan(question) {
  refreshAsanaProjects(12);
  const targets = listTargets();
  const routeSystem = 'You route a short work note to one destination from a fixed list. '
    + 'You reply with exactly one JSON object and nothing else. Ids are copied character-for-character '
    + 'from the list you were given; you never invent one, and you answer "none" rather than guess.';
  // The mail comes first, not alongside: its sender is what the routing call needs to
  // see, so for an "email" entry the ~1s IMAP round trip is on the critical path.
  const mail = await findMail(question);
  const [routed, hit] = await Promise.all([
    askModel(routingPrompt(question, targets, mail), routeSystem),
    findAsanaTask(question, targets),
  ]);
  const plan = parseSessionPlan(routed, targets);
  // An entry that names a task we hold is not a classification problem — the project
  // it is filed in is the answer, so it outranks whatever the model decided.
  if (hit) { plan.target = hit.target; plan.task = hit.task; }
  // Likewise a mail whose sender is a known client: the registry says where it goes.
  if (mail) {
    plan.kind = 'email';
    plan.mail = mail;
    const t = mailTarget(mail, targets);
    if (t) plan.target = t;
  }
  plan.slug = plan.slug || timestampName();
  plan.existing = await findExistingFolder(question, plan);
  return plan;
}

function routingPrompt(question, targets, mail) {
  {
    // Clients get a line each — the company name is what makes an opaque shortcode
    // matchable. Repos are just names, on one line: spelling out "local dev project"
    // 58 times cost more latency than it ever bought in accuracy.
    const homes = targets.filter((t) => !t.id.startsWith('repo:'));
    const repos = targets.filter((t) => t.id.startsWith('repo:'));
    const prompt = [
      'Route one entry from a "New Task" box.',
      '',
      'Entry:', question, '',
      ...mailContext(mail),
      'Clients and house projects — "<id> — <Asana project> — <client or subject>":',
      ...homes.map((t) => `${t.id} — ${t.name} — ${t.desc}`),
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
      '- An "asana" or "email" entry belongs to the client or house target whose client or',
      '  subject it is about — that decides the Asana project it will be filed in.',
      '- A "session" entry belongs to a repo: target when it names one, otherwise to the',
      '  client: target for the client it is about. A client is a valid destination even',
      '  when its own shortcode is all the entry says about it.',
      '- Shortcodes that merely look alike (RAH vs RAHR, PR vs PRX) are unrelated clients.',
      '  Never guess from a resemblance — prefer "none".',
      '- slug: exactly two lowercase words joined by a hyphen, summarising the entry.',
    ].join('\n');
    return prompt;
  }
}

// The head of a file, not the file: a HANDOFF.md runs to tens of kilobytes and there are
// up to 60 folders to look at. Everything read here — the title line, the gid on line 5 —
// is in the first few hundred bytes.
function fileHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} }
}

// What the folder is ABOUT, in the words the work itself used. Folder names are two-word
// slugs, and matching an entry against a bare slug is matching wordplay: "rah 4. Final
// Local Folders copy" was read as a continuation of "rah-destination-side" — a backup
// freshness check — because "copy" and "destination" sit near each other and nothing in
// the prompt said what that folder held.
function folderSubject(dir) {
  for (const f of ['TASK.md', 'HANDOFF.md', 'README.md']) {
    const line = (fileHead(path.join(dir, f)).split('\n').find((l) => l.trim()) || '').trim();
    if (!line) continue;
    return line
      .replace(/^#+\s*/, '')
      .replace(/^HANDOFF\s*[—–-]\s*/i, '')
      .replace(/^[\s✨🔴🟠🟡🟢⚠️]+/u, '')
      .trim()
      .slice(0, 90);
  }
  return '';
}

// The Asana task a folder belongs to, when it belongs to one: the bridge writes the gid
// into its marker file, and a task directory carries it in TASK.md. This is evidence, not
// a resemblance — the folder for a task is the one that says so.
function folderTaskGid(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '.asana-claude.json'), 'utf8'));
    if (j && j.taskGid) return String(j.taskGid);
  } catch {}
  const m = fileHead(path.join(dir, 'TASK.md')).match(/Task GID:\**\s*`?(\d{6,})/i);
  return m ? m[1] : '';
}

// Coming back to a task or a mail should land in the folder it already has, not beside
// it. Past entries left their slug as a folder name under the same target, so this is a
// name-matching question — one more ~1s call on top of the routing. Only targets that
// hold one folder per piece of work are searched; a repo target IS the working directory.
//
// Two things are NOT a judgement call here. A folder that already carries an Asana gid is
// the home of that one task: it is reachable by naming that task and no other way, because
// a session resumed there inherits the bridge's ASANA_TASK_GID and posts its comments onto
// whatever task the folder belongs to. And when the entry itself resolved to a task, the
// gid decides — matching by gid or starting fresh, never asking the model to guess.
async function findExistingFolder(question, plan) {
  const root = plan.target
    ? (plan.target.create ? plan.target.dir : null)
    : expandHome(cfg().get('scratchDir') || '~/tasks');
  if (!root) return null;
  const folders = dirsIn(root)
    .map((name) => {
      const dir = path.join(root, name);
      let mtime = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch {}
      return { name, dir, mtime, gid: folderTaskGid(dir) };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 60);
  if (!folders.length) return null;
  // The entry named a task we hold, so there is nothing to weigh: its folder is the one
  // stamped with its gid. No stamp means this task has no folder yet — a new one, not the
  // nearest-looking neighbour.
  const wanted = plan.task && plan.task.gid ? String(plan.task.gid) : '';
  if (wanted) {
    const hit = folders.find((f) => f.gid === wanted);
    return hit ? hit.dir : null;
  }
  // A folder a task already owns is not a destination for an entry we could not tie to
  // that task — a session resumed there inherits its gid. It stays in the list shown to
  // the model, though: hiding the folder an entry genuinely belongs to only pushes the
  // answer onto the next-nearest lookalike, and "the right folder, not reusable" has to
  // come out as a fresh folder rather than as somebody else's.
  //
  // The slug is generated from the entry, so the same subject twice often names the
  // same folder — worth checking for free before asking.
  const exact = folders.find((f) => !f.gid && f.name === plan.slug);
  if (exact) return exact.dir;
  // Worked examples do the heavy lifting here: "same client, different subject" is the
  // mistake this call makes, and stating the rule abstractly was not enough to stop it.
  const system = [
    'You match a short work note against a list of existing folders.',
    'Each line is a folder name, and where the work recorded one, " — " and its subject.',
    'You reply with exactly one line and nothing else: either a folder name copied',
    'character-for-character from the list, or the single word none.',
    'You are strict. A folder is only a match when it is about the SAME specific thing the',
    'note is about — the same machine, ticket, document, person or fault. Sharing a',
    'client, a technology or a general area is not a match. When in any doubt: none.',
  ].join(' ');
  const prompt = [
    'Work note:', question, '',
    'Existing folders:',
    ...folders.map((f) => {
      const subject = folderSubject(f.dir);
      return subject ? `${f.name} — ${subject}` : f.name;
    }),
    '',
    'Examples of the judgement:',
    '- note "the VPN keeps dropping at DRM", folder "vpn-restart-problem" → vpn-restart-problem (same fault)',
    '- note "DRM needs a new Exchange connector", folder "DRM-webserverinstall" → none (both DRM, different subject)',
    '- note "set up the new printer", folder "rahr-usb-copy" → none (both hardware, different device)',
    '',
    'Which folder is this note a continuation of? Reply with the folder name, or none.',
  ].join('\n');
  const answer = (await askModel(prompt, system)).trim().split('\n').filter(Boolean).pop() || '';
  const want = answer.trim().replace(/^[`'"]+|[`'".]+$/g, '').toLowerCase();
  if (!want || want === 'none') return null;
  const hit = folders.find((f) => f.name.toLowerCase() === want);
  return hit && !hit.gid ? hit.dir : null;
}

// A target only counts if it matches one we actually offered — a model that invents or
// misremembers a shortcode must degrade to the scratch folder, never write into some
// other client's directory.
function parseSessionPlan(stdout, targets) {
  const out = { slug: '', kind: 'session', target: null, task: null };
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
function decoratePrompt(q, kind, target, task, mail) {
  if (kind === 'asana') {
    // The search the cold instruction below asks for has already been done, by name and
    // exactly: this IS that task. Saying so is what stops the sixth copy of it.
    if (task) {
      return [
        `Comment on the existing Asana task "${task.name}" (${task.gid}) — do NOT create a second one.`,
        ...(task.permalink_url ? [task.permalink_url] : []),
        'Follow the comment conventions in CLAUDE.md and refresh the Status line with `asana status`.',
        '', 'Note:', q,
      ].join('\n');
    }
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
    if (mail) {
      return [
        `Reply to this mail with the email-writing skill, then show the draft and wait for approval — nothing is sent unprompted.${about}`,
        'Read the full thread first (Gmail MCP, or the link below) and answer what it actually asks.',
        `From: ${mail.from}`,
        `Subject: ${mail.subject}`,
        `Date: ${mail.date}`,
        ...(mail.thread_link ? [mail.thread_link] : []),
        '', 'Note:', q,
      ].join('\n');
    }
    return [
      `Draft this email with the email-writing skill, then show it and wait for approval — nothing is sent unprompted.${about}`,
      '', 'Mail:', q,
    ].join('\n');
  }
  // A "session" entry says what it wants and is passed through — but when the entry is
  // the NAME of a task we hold, the session is working that task and should say so in the
  // right place rather than opening a second one for the same thing.
  if (task) {
    return [
      `This is Asana task "${task.name}" (${task.gid}) — work it there; do NOT create a second one.`,
      ...(task.permalink_url ? [task.permalink_url] : []),
      '', q,
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
  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Claude: routing task…' },
    () => generateSessionPlan(q)
  );
  const slug = plan.slug || timestampName();
  let kind = plan.kind;
  let target = plan.target || scratchTarget(slug);
  let existing = plan.existing;
  let task = plan.task || null;
  const mail = plan.mail || null;

  for (;;) {
    const reply = await io.propose({
      kind,
      kindLabel: KIND_LABEL[kind],
      target: task ? `${target.name} — existing task`
        : (mail && mail.from_address ? `${target.name} — mail from ${mail.from_address}` : target.name),
      dir: shortHome(existing || targetDir(target, slug)),
      existing: !!existing,
    });
    if (!reply || reply.type === 'cancel') { state('idle', true); return; }
    // Tab cycles the intent in the box, so any reply can carry a changed one — including
    // the one that only asks for the folder picker.
    if (reply.kind && KIND_LABEL[reply.kind]) kind = reply.kind;
    if (reply.type !== 'pickTarget') break;
    // Reaching for the picker is how you say "not that folder", so a proposed
    // continuation is dropped: pick the same target again and you get a fresh one.
    // The task found by name belongs to the target that was just rejected, so it goes
    // with it — commenting on it from another client's folder would be worse than not
    // having found it.
    existing = null;
    task = null;
    const picked = await pickTarget(slug);
    if (picked) target = picked;
  }

  const create = !existing && target.create;
  const dir = existing || (create ? uniqueDir(targetDir(target, slug)) : target.dir);
  // `create` invents a slug subfolder inside a home for many sessions; `ensure` is
  // the picker's typed path, which is already the exact folder and only has to exist.
  if (create || (!existing && target.ensure && !fs.existsSync(dir))) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      state('idle', true);
      vscode.window.showErrorMessage(`Claude Code Helper: could not create ${dir} — ${e.message}`);
      return;
    }
  }
  // Continuing into a folder that already holds a session resumes it rather than
  // starting a second one beside it — and a resumed session already knows what it is
  // working on, so it gets the entry as typed, without the framing a cold start needs.
  const resume = !!existing && listSessions(dir).length > 0;
  state('launching');
  let started = false;
  try {
    started = !!(await launchClaude(
      { path: dir, label: path.basename(dir) }, resume,
      { skipNamePrompt: true, initialPrompt: resume ? q : decoratePrompt(q, kind, target, task, mail) }
    ));
  } finally {
    state('idle', !started);
  }
}

// Everywhere a session can go as a plain folder: first-level ~/projects, and first-
// AND second-level ~/clients. The Asana table only names places that have a project,
// so a client's one-off subfolder (~/clients/BF/router-swap) is reachable no other
// way. These run the session IN the folder — no slug subfolder is invented, because
// picking an exact folder is the point.
function listFolderTargets() {
  const out = [];
  const proj = projectsRoot();
  for (const name of dirsIn(proj)) {
    out.push({ id: `repo:${name}`, name, dir: path.join(proj, name), create: false, desc: 'local dev project', group: 'Projects' });
  }
  const root = clientsRoot();
  for (const code of dirsIn(root)) {
    const dir = path.join(root, code);
    const desc = clientName(dir) || `client ${code.replace(/^#/, '')}`;
    out.push({ id: `dir:${dir}`, name: code, dir, create: false, desc, group: 'Client folders' });
    for (const sub of dirsIn(dir)) {
      const sd = path.join(dir, sub);
      out.push({ id: `dir:${sd}`, name: `${code} / ${sub}`, dir: sd, create: false, desc, group: 'Client folders' });
    }
  }
  return out;
}

// What a typed path means. It is read against the same roots the list is built from,
// so "BF/router-swap" and "claude-code-helper/spike" both land where you would guess;
// a first segment that matches no client and no project falls through to scratch,
// which is also where a bare word ends up. Returns null for nonsense (a '..' escape).
function resolveTypedDir(text) {
  const raw = String(text || '').trim().replace(/[\\/]+$/, '');
  if (!raw) return null;
  if (raw.startsWith('~/') || path.isAbsolute(raw)) return expandHome(raw);
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..')) return null;
  const [head, ...rest] = parts;
  const tail = rest.join(path.sep);
  if (head === 'clients') return rest.length ? path.join(clientsRoot(), tail) : null;
  if (head === 'projects') return rest.length ? path.join(projectsRoot(), tail) : null;
  const c = clientDir(head, null, rest[0]);
  if (c) return tail ? path.join(c, tail) : c;
  const p = path.join(projectsRoot(), head);
  if (fs.existsSync(p)) return tail ? path.join(p, tail) : p;
  return path.join(expandHome(cfg().get('scratchDir') || '~/tasks'), parts.join(path.sep));
}

// The override behind Shift+Tab: scratch, then the client/house routing table, then every
// project and client subfolder — and, live as you type, an offer to create whatever
// path you are typing if it does not exist yet.
async function pickTarget(slug) {
  const scratch = scratchTarget(slug);
  const homes = listTargets().filter((t) => !String(t.id).startsWith('repo:'));
  const taken = new Set(homes.map((t) => t.dir).filter(Boolean));
  const folders = listFolderTargets().filter((t) => !taken.has(t.dir));
  const toItem = (t) => ({
    label: `$(folder) ${t.name}`,
    description: shortHome(targetDir(t, slug)),
    detail: t.desc,
    target: t,
  });
  const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const items = [toItem(scratch)];
  if (homes.length) items.push(sep('Clients & house projects'), ...homes.map(toItem));
  for (const group of ['Projects', 'Client folders']) {
    const inGroup = folders.filter((t) => t.group === group);
    if (inGroup.length) items.push(sep(group), ...inGroup.map(toItem));
  }

  const qp = vscode.window.createQuickPick();
  qp.placeholder = 'Where does this belong? — or type a new path (BF/router-swap) to create it';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = items;
  // Rebuilt only when the offer itself changes: reassigning items resets the
  // highlighted row, which on every keystroke would fight the typing.
  let offered = null;
  const render = () => {
    const dir = resolveTypedDir(qp.value);
    const create = dir && !fs.existsSync(dir) ? dir : null;
    if (create === offered) return;
    offered = create;
    qp.items = create ? [{
      label: `$(new-folder) Create ${shortHome(create)}`,
      detail: 'new folder — the session starts in it',
      alwaysShow: true,
      target: { id: `new:${create}`, name: path.basename(create), dir: create, create: false, ensure: true, desc: 'new folder' },
    }, ...items] : items;
  };
  qp.onDidChangeValue(render);
  return new Promise((resolve) => {
    let picked;
    qp.onDidAccept(() => { picked = qp.selectedItems[0]; qp.hide(); });
    qp.onDidHide(() => { qp.dispose(); resolve(picked ? picked.target : null); });
    qp.show();
  });
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
  const CONTINUE = 'Enter continue · Tab intent · Shift+Tab new folder · Esc cancel';
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
      dirEl.textContent = (m.existing ? 'continue in ' : '') + m.dir;
      plan.classList.add('on');
      hint.textContent = m.existing ? CONTINUE : CONFIRM;
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
    else {
      stopTick(); hint.textContent = IDLE;
      // refocus means nothing launched — a cancel or a failure — so the text stays
      // put and the cursor goes back to it. A launched session takes the text with it.
      if (m.refocus) q.focus();
      else { q.value = ''; grow(); }
    }
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

// The one place that decides which state file belongs to a terminal, so the
// provider and the refresh below can never disagree about it.
function tabStateKeyForTerminal(terminal) {
  return tabStateIdByTerminal.get(terminal) || tabStateIdFromEnviron(terminal) || tabStateCwdKey(terminal) || null;
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

// Is there actually a master to attach to? asana-bridge2 deleted the dtach layer
// on purpose (see its file header): a picked-up task runs as a headless
// `claude -p` child of the bridge, so `claude agents --json` reports the session
// live while ~/.claude/dtach holds no socket for it. Attaching regardless is what
// this view used to do, and it could only ever answer
// `dtach: …/<id>.sock: No such file or directory` (seen 2026-08-20 on the
// ✨ SAX Kopierer task). Takeover for those is a RESUME into a dtach master of
// our own — which is exactly what the bridge's header documents as human takeover.
function agentAttachable(entry) {
  if (!entry) return false;
  if (entry.tmuxName) return tmuxAlive(entry.tmuxName);
  return !!(entry.sessionId && sessionDtachSocket(entry.sessionId));
}

// The bridge's run lock — the pid of its headless run while one is in flight.
// Resuming underneath it puts two claude processes on one transcript: the CLI's
// own conflict guard does not fire, because a `claude -p` run registers itself as
// `kind: "interactive"` (asana-bridge2.js, "Run lock"). Null when no run is alive.
function bridgeRunInFlight(dir) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, '.bridge-run.lock'), 'utf8')); }
  catch { return null; }
  if (!lock || !lock.pid) return null;
  try { process.kill(lock.pid, 0); } catch { return null; }
  return lock;
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
  if (entry.tmuxName) {
    metaLines.push(`🖥️ \`tmux -L ${agentSocket()} attach -t ${entry.tmuxName}\``);
  } else if (agentAttachable(entry)) {
    metaLines.push(`🖥️ \`dtach -a ${path.join(dtachSocketDir(), entry.sessionId + '.sock')} -E -z -r winch\``);
  } else if (live) {
    metaLines.push('🖥️ headless bridge run — nothing to attach to; opening it resumes the transcript in a terminal of ours');
  }
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

async function attachAgentSession(node) {
  if (!node || !node.entry) return;
  const e = node.entry;
  // Re-checked at click time, not taken from render time: the session may have
  // ended in the meantime, in which case resuming from the transcript is correct.
  if (!agentLive(e)) {
    vscode.window.showWarningMessage(`Agent session "${e.displayName}" is no longer running — resuming instead.`);
    return resumeAgentSession(node);
  }
  // Live, but with no master behind it: a bridge-v2 headless run. Resume it into
  // a dtach master of ours instead of emitting an attach to a socket that was
  // never created — but say so first when the bridge is still mid-run, because
  // the takeover then means two claude processes appending to one transcript.
  if (!agentAttachable(e)) {
    const lock = bridgeRunInFlight(e.dir);
    if (lock) {
      const started = Date.parse(lock.startedAt);
      const since = Number.isFinite(started) ? relativeTime(started) : 'a while ago';
      const TAKE = 'Take Over Anyway';
      const answer = await vscode.window.showWarningMessage(
        `“${e.displayName}” is a headless bridge run — there is no terminal session to attach to.`,
        {
          modal: true,
          detail: `The Asana bridge started it ${since} (pid ${lock.pid}) and it is still working. `
            + 'Taking over now starts a second Claude on the same transcript. '
            + 'The normal move is to wait for its Asana comment and take over once it has stopped.',
        },
        TAKE);
      if (answer !== TAKE) return;
    }
    return resumeAgentSession(node);
  }
  const name = `▶ ${e.displayName}`;
  let terminal = vscode.window.terminals.find((t) => t.name === name);
  const created = !terminal;
  if (!terminal) terminal = vscode.window.createTerminal({ name, cwd: fs.existsSync(e.dir) ? e.dir : undefined });
  terminal.show();
  if (created) moveTerminalTabToEnd();
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

// ─── go to folder ────────────────────────────────────────────────────────────
//
// Quick Open (Ctrl+P) indexes files only — VS Code has no way to jump to a
// FOLDER by name. This is that picker: it scans a handful of roots for
// directories and hands the pick to the same actions the favourites tree uses.

function folderSearchRoots() {
  const raw = cfg().get('folderSearchRoots');
  const list = Array.isArray(raw) && raw.length ? raw : ['~/clients', '~/projects'];
  return list.map(expandHome).filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

// `fd` walks a deep tree far faster than `find`; Debian ships it as `fdfind`.
let fdBinCache;
function fdBinary() {
  if (fdBinCache !== undefined) return fdBinCache;
  fdBinCache = null;
  for (const bin of ['fd', 'fdfind']) {
    try {
      cp.execFileSync(bin, ['--version'], { stdio: 'ignore' });
      fdBinCache = bin;
      break;
    } catch { /* not installed */ }
  }
  return fdBinCache;
}

function scanDirs(root, depth, excludes) {
  return new Promise((resolve) => {
    const fd = fdBinary();
    const [bin, args] = fd
      ? [fd, ['--type', 'd', '--no-ignore', '--max-depth', String(depth),
              ...excludes.flatMap((e) => ['--exclude', e]), '.', root]]
      // find has no --exclude; prune the excluded names (and every dotdir) instead.
      : ['find', [root, '-mindepth', '1', '-maxdepth', String(depth),
                  '(', '-name', '.*', ...excludes.flatMap((e) => ['-o', '-name', e]), ')',
                  '-prune', '-o', '-type', 'd', '-print']];
    let out = '';
    let child;
    try {
      child = cp.spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return resolve([]); }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve([]));
    // fd exits 1 when nothing matched — take whatever came out either way.
    child.on('close', () => resolve(out.split('\n').map((s) => s.replace(/\/$/, '')).filter(Boolean)));
  });
}

async function listFolders() {
  const roots = folderSearchRoots();
  if (!roots.length) return [];
  const depth = Math.max(1, Number(cfg().get('folderSearchDepth')) || 3);
  const raw = cfg().get('folderSearchExcludes');
  const excludes = Array.isArray(raw) ? raw : ['node_modules', '.git', 'venv', '.venv', 'dist', 'build'];
  const lists = await Promise.all(roots.map((r) => scanDirs(r, depth, excludes)));
  const seen = new Set();
  const dirs = [];
  for (const p of lists.flat()) {
    if (seen.has(p)) continue;
    seen.add(p);
    dirs.push(p);
  }
  return dirs.sort();
}

// What Enter does, and what the per-item buttons offer. Keys are the values of
// the claudeHelper.folderSearchAction setting.
const FOLDER_ACTIONS = {
  openFolder: {
    icon: 'folder-opened', label: 'Open Folder in New Window',
    run: (p) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true }),
  },
  terminal: {
    icon: 'terminal', label: 'Open Terminal Here',
    run: (p) => {
      const t = vscode.window.createTerminal({ name: path.basename(p), cwd: p });
      t.show();
      moveTerminalTabToEnd();
    },
  },
  startClaude: {
    icon: 'rocket', label: 'Start Claude Here',
    run: (p) => startClaude(favFromUri(vscode.Uri.file(p))),
  },
  newFolder: {
    icon: 'new-folder', label: 'New Subfolder & Start Claude',
    run: (p) => newFolderAndStartClaudeFromUri(vscode.Uri.file(p)),
  },
  reveal: {
    icon: 'eye', label: 'Reveal in Explorer',
    // revealInExplorer silently does nothing for a path outside every open root,
    // and the search roots are deliberately wider than the workspace — so say so
    // and offer the two ways in rather than swallowing the keypress.
    run: async (p) => {
      const uri = vscode.Uri.file(p);
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        const pick = await vscode.window.showWarningMessage(
          `${shortHome(p)} is outside the open workspace.`,
          'Add to Workspace', 'Open in New Window');
        if (pick === 'Add to Workspace') {
          vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, null, { uri });
        } else if (pick === 'Open in New Window') {
          vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        }
        return;
      }
      await vscode.commands.executeCommand('revealInExplorer', uri);
    },
  },
  favourite: {
    icon: 'star-add', label: 'Add to Favourites',
    run: (p, ctx) => addFavouriteFromUri(ctx, vscode.Uri.file(p), { askLabel: false }),
  },
};

// A QuickPick cannot see key chords itself, so the Ctrl+Enter shortcut arrives
// as a normal command and needs a handle on the picker that is currently open.
let folderSearchOpen = null;   // { dir, run } while visible, null otherwise

async function goToFolder(ctx) {
  const defaultKey = FOLDER_ACTIONS[cfg().get('folderSearchAction')] ? cfg().get('folderSearchAction') : 'openFolder';
  const buttons = Object.entries(FOLDER_ACTIONS)
    .filter(([key]) => key !== defaultKey)
    .map(([key, a]) => ({ key, iconPath: new vscode.ThemeIcon(a.icon), tooltip: a.label }));

  const qp = vscode.window.createQuickPick();
  qp.placeholder = `Folder name… (Enter: ${FOLDER_ACTIONS[defaultKey].label} · Ctrl+Enter: New Subfolder & Start Claude)`;
  qp.matchOnDescription = true;
  qp.busy = true;
  let alive = true;
  const setOpenContext = (v) =>
    vscode.commands.executeCommand('setContext', 'claudeHelper.folderSearchOpen', v);
  qp.onDidHide(() => {
    alive = false;
    folderSearchOpen = null;
    setOpenContext(false);
    qp.dispose();
  });

  const run = (key, dir) => {
    qp.hide();
    Promise.resolve(FOLDER_ACTIONS[key].run(dir, ctx)).catch((e) =>
      vscode.window.showErrorMessage(`Claude Code Helper: ${e && e.message ? e.message : e}`));
  };
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    if (item) run(defaultKey, item.dir);
  });
  qp.onDidTriggerItemButton((e) => run(e.button.key, e.item.dir));
  qp.onDidChangeActive((items) => {
    if (folderSearchOpen) folderSearchOpen.dir = items[0] ? items[0].dir : null;
  });
  folderSearchOpen = { dir: null, run };
  setOpenContext(true);
  qp.show();

  const dirs = await listFolders();
  if (!alive) return;
  if (!dirs.length) {
    qp.hide();
    vscode.window.showWarningMessage(
      `Claude Code Helper: nothing to search. Check claudeHelper.folderSearchRoots (${(cfg().get('folderSearchRoots') || []).join(', ') || 'unset'}).`);
    return;
  }
  qp.items = dirs.map((d) => ({
    label: path.basename(d),
    description: shortHome(path.dirname(d)),
    dir: d,
    buttons,
  }));
  qp.busy = false;
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

  // Tab state decorations — see the "tab state decorations" section above.
  tabStateSeedTerminals();
  tabStateProvider = new TabStateDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(tabStateProvider));
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((t) => tabStateTerminalOpened(t)),
    vscode.window.onDidCloseTerminal((t) => tabStateTerminalClosed(t)),
    vscode.window.onDidChangeActiveTerminal((t) => tabStateTerminalFocused(t))
  );
  startTabStateWatcher(context);
  setTimeout(tabStateSweepStale, 5000);
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
  reg('claudeHelper.goToFolder', () => goToFolder(context));
  reg('claudeHelper.folderSearchNewSubfolder', () => {
    if (folderSearchOpen && folderSearchOpen.dir) folderSearchOpen.run('newFolder', folderSearchOpen.dir);
  });
  reg('claudeHelper.newSession', () => newScratchSession());
  reg('claudeHelper.startClaude', (fav) => startClaude(fav));
  reg('claudeHelper.resumeClaude', (fav) => resumeClaude(fav));
  reg('claudeHelper.startClaudeFromExplorer', (uri) => startClaudeFromUri(uri));
  reg('claudeHelper.newFolderAndStartClaudeFromExplorer', (uri) => newFolderAndStartClaudeFromUri(uri));
  reg('claudeHelper.resumeClaudeFromExplorer', (uri) => resumeClaudeFromUri(uri));
  reg('claudeHelper.openTerminalHere', (fav) => {
    if (!fav) return;
    const t = vscode.window.createTerminal({ name: fav.label || path.basename(fav.path), cwd: fav.path });
    t.show();
    moveTerminalTabToEnd();
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
