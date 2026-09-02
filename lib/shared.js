const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
function cfg() {
  return vscode.workspace.getConfiguration('claudeHelper');
}

function shortHome(p) {
  if (!p) return '';
  if (!cfg().get('shortenPaths', true)) return p;
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Single-quote a string for a POSIX shell. Used for the initial-prompt argument,
// which is arbitrary user text and ends up inside .run-claude.sh / sendText.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
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
    // A bridge session opens with custom-title, agent-name and queue-operation
    // records — one of them 10 kB on its own — so the first record carrying `cwd`
    // can sit past the 16 kB head window. The only fallback then is decoding the
    // project folder name, which is ambiguous the moment a directory has a dash
    // in it (`-home-work-clients-EEB-ingest-hetzner-plann` decodes to
    // `/home/work/clients/EEB/ingest/hetzner/plann`), so clicking such a session
    // could only answer "Can't determine working directory" — a live, healthy
    // session made unattachable by where a record happened to land in the file.
    // The tail is already in memory; take the cwd from there when the head had none.
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
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

function relativeTime(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
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

function decodeProjectFolder(folder) {
  // best-effort: replace - with /, then verify existence
  const decoded = folder.replace(/-/g, '/');
  if (fs.existsSync(decoded)) return decoded;
  return null;
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

module.exports = {
  cfg, shortHome, makeId, shq, timestampName, DATE_NAME_RE, slugifyTitle, encodeProjectDir,
  LIST_TTL_MS, listSessions, extractText, readChunk, readSessionMeta, emptyMeta, readSessionTitle,
  snippet, escMd, oneLine, buildTooltip, buildSessionTooltip, buildFavouriteTooltip, relativeTime,
  useTmux, useDtach, dtachSocketDir, decodeProjectFolder, expandHome,
};
