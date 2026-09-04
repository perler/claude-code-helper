const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');

const { cfg, encodeProjectDir, extractText, listSessions, readChunk, readSessionMeta, relativeTime, shortHome } = require('./shared');
const {
  tabStateDtachSessionId, tabStatePidByTerminal, tabStateProcAlive, tabStateSessionsDir,
  tabStateTerminalCwd, tabStateWordForSessionStatus,
} = require('./tabstate');
const { getTerminalCwd, sessionIdForTerminal } = require('./terminals');

// ─── Live Session panel ──────────────────────────────────────────────────────
//
// A webview in the editor group NEXT TO a Claude session's terminal, showing what
// that session is doing right now: its status, the files it has changed, and the
// last few things it did. Opening it is also what narrows the terminal — a Claude
// TUI given the full width of a 4K screen wraps at ~143 columns, which is a head
// turn per line to read. The panel takes the right third and the TUI reflows into
// what is left.
//
// Everything here is READ-ONLY and derived from files the CLI already writes:
//   ~/.claude/sessions/<pid>.json      live status (idle / busy / …), pid, cwd
//   ~/.claude/projects/<dir>/<id>.jsonl  the transcript, tail-read for activity
//   git status in the session's cwd    what actually changed on disk
// Nothing is cached across windows and nothing is written, so removing this file
// removes the feature.
//
// Why git and not the transcript for "changed files": under
// --dangerously-skip-permissions most edits are made with `sed`/heredocs through
// Bash rather than the Edit tool, so the transcript's own file-history records
// see only a fraction of them. Git sees all of it. The transcript's record is
// used only as a fallback for a cwd that is not a repository.

function livePanelEnabled() { return cfg().get('livePanel') !== false; }

const ACTIVITY_LIMIT = 60;

// How much of the transcript's tail to parse. A long session's .jsonl runs to
// megabytes and is appended to constantly, so the panel never reads the whole
// thing — 512 kB is a few hundred records, comfortably more than ACTIVITY_LIMIT
// even when tool results are large.
const TAIL_BYTES = 512 * 1024;

// ─── which session a terminal is showing ─────────────────────────────────────
//
// Four routes, strongest first, mirroring how tabstate.js identifies a tab. The
// last two are guesses from the working directory and are only trusted when the
// answer is unambiguous — a panel showing the wrong session is worse than one
// showing nothing.

function transcriptFile(sessionId, cwd) {
  if (!sessionId || !cwd) return null;
  const f = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`);
  return fs.existsSync(f) ? f : null;
}

// Every live session the CLI knows about, from its own per-pid session files.
function liveSessions() {
  const out = [];
  let files;
  try { files = fs.readdirSync(tabStateSessionsDir()); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(tabStateSessionsDir(), f), 'utf8')); } catch { continue; }
    if (!s || typeof s.pid !== 'number' || !tabStateProcAlive(s.pid, s.procStart)) continue;
    out.push(s);
  }
  return out;
}

function liveSessionById(sessionId) {
  return liveSessions().find((s) => s.sessionId === sessionId) || null;
}

function resolveSession(terminal) {
  if (!terminal) return null;
  const termCwd = tabStateTerminalCwd(terminal)
    || ((getTerminalCwd(terminal) || {}).fsPath || null);

  const settle = (sessionId, cwd) => {
    if (!sessionId) return null;
    const live = liveSessionById(sessionId);
    const dir = (live && live.cwd) || cwd || termCwd;
    const file = transcriptFile(sessionId, dir);
    if (!file && !live) return null;
    return { sessionId, cwd: dir, file, live };
  };

  // 1. This window launched or attached it, so the mapping is recorded.
  const direct = sessionIdForTerminal(terminal);
  if (direct) return settle(direct, termCwd);

  // 2. A dtach attach terminal carries the session id in its client's argv —
  //    the route that survives a window reload, where the map above is empty.
  const pid = tabStatePidByTerminal.get(terminal);
  const viaDtach = pid ? tabStateDtachSessionId(pid) : null;
  if (viaDtach) return settle(viaDtach, termCwd);

  if (!termCwd) return null;

  // 3. Exactly one live session in this directory — then it is that one. With
  //    two, the directory cannot say which tab is which, same rule the tab
  //    badges apply.
  //
  //    The Claude Code sidebar extension starts a session of its own in every
  //    window it opens (`entrypoint: "claude-vscode"`), which sits in the
  //    workspace folder and has no terminal at all. Counting it makes almost
  //    every folder look ambiguous — measured: opening ~/tasks/livepanel-check
  //    put a second session in a directory that had exactly one — so it is left
  //    out of the census. Any other entrypoint still counts.
  const here = liveSessions().filter((s) => s.cwd === termCwd && s.entrypoint !== 'claude-vscode');
  if (here.length === 1) return settle(here[0].sessionId, termCwd);
  if (here.length > 1) return null;

  // 4. Nothing running here: show the newest transcript in the folder, which is
  //    what a terminal sitting at a finished session is looking at.
  const list = listSessions(termCwd);
  return list.length ? settle(list[0].id, termCwd) : null;
}

// ─── the transcript's tail ───────────────────────────────────────────────────

function tailLines(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  if (!st.size) return [];
  const start = Math.max(0, st.size - TAIL_BYTES);
  const text = readChunk(file, start, st.size - start);
  const lines = text.split('\n');
  if (start > 0 && lines.length > 1) lines.shift();   // the first line is a fragment
  return lines.filter(Boolean);
}

function firstLine(s) {
  return String(s || '').split('\n').find((l) => l.trim()) || '';
}

function toolItem(c, ts) {
  const input = (c && c.input) || {};
  const name = c.name || 'tool';
  if (name === 'Bash') {
    const cmd = firstLine(input.command);
    return { kind: 'tool', ts, label: '$', text: input.description || cmd, title: input.command || '' };
  }
  if (typeof input.file_path === 'string') {
    return { kind: 'tool', ts, label: name, text: path.basename(input.file_path), title: input.file_path, file: input.file_path };
  }
  if (name === 'Agent' || name === 'Task') {
    return { kind: 'tool', ts, label: name, text: input.description || firstLine(input.prompt), title: firstLine(input.prompt) };
  }
  const arg = input.pattern || input.query || input.url || input.skill || input.command || '';
  return { kind: 'tool', ts, label: name, text: firstLine(arg), title: String(arg) };
}

// Newest first, so the interesting end of a long session is the part that needs
// no scrolling in a narrow column.
function readActivity(file) {
  const out = [];
  for (const line of tailLines(file)) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (r.type === 'user' && r.message) {
      // A tool_result comes back as a `user` record too; extractText skips those
      // wrappers, so anything with prose here is something you actually typed.
      const t = extractText(r.message.content);
      if (t && t.trim()) out.push({ kind: 'you', ts, text: t.trim(), title: t.trim() });
      continue;
    }
    if (r.type !== 'assistant' || !r.message || !Array.isArray(r.message.content)) continue;
    for (const c of r.message.content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        out.push({ kind: 'say', ts, text: c.text.trim(), title: c.text.trim() });
      } else if (c.type === 'tool_use') {
        out.push(toolItem(c, ts));
      }
    }
  }
  return out.slice(-ACTIVITY_LIMIT).reverse();
}

// The transcript's own view of what was edited — cumulative, and only what went
// through the Edit/Write tools. Used when the cwd is not a git repository.
function touchedFromTranscript(file) {
  const out = new Map();
  for (const line of tailLines(file)) {
    if (!line.includes('trackedFileBackups')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const backups = r.snapshot && r.snapshot.trackedFileBackups;
    if (!backups) continue;
    for (const [rel, b] of Object.entries(backups)) {
      const full = b && b.realParentDir ? path.join(b.realParentDir, path.basename(rel)) : rel;
      out.set(rel, { path: full, rel, status: 'edited', add: null, del: null });
    }
  }
  return [...out.values()];
}

// ─── what changed on disk ────────────────────────────────────────────────────

function git(cwd, args) {
  return new Promise((resolve) => {
    cp.execFile('git', ['-C', cwd, ...args], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

async function gitChanges(cwd) {
  const status = await git(cwd, ['status', '--porcelain']);
  if (status === null) return null;                 // not a repo, or no git
  const rows = [];
  for (const line of status.split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    // A rename prints "old -> new"; the new name is the one worth opening.
    const raw = line.slice(3);
    const rel = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
    const clean = rel.replace(/^"|"$/g, '');
    rows.push({ path: path.resolve(cwd, clean), rel: clean, status: code.trim() || '?', add: null, del: null });
  }
  if (!rows.length) return rows;
  const numstat = await git(cwd, ['diff', '--numstat', 'HEAD', '--']);
  if (numstat) {
    const byRel = new Map(rows.map((r) => [r.rel, r]));
    for (const line of numstat.split('\n')) {
      const [a, d, rel] = line.split('\t');
      const row = rel && byRel.get(rel);
      if (!row) continue;
      row.add = a === '-' ? null : Number(a);
      row.del = d === '-' ? null : Number(d);
    }
  }
  return rows;
}

// The `git:` URI for a file's committed version, via the built-in Git extension's
// API. Returns null when that extension is absent or has no repository for this
// path — the two cases where a diff cannot be produced at all.
function gitHeadUri(uri) {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext || !ext.isActive) return null;
    const api = ext.exports.getAPI(1);
    if (!api || typeof api.toGitUri !== 'function') return null;
    const inRepo = (api.repositories || []).some((r) => {
      const root = r.rootUri.fsPath.replace(/\/+$/, '');
      return uri.fsPath === root || uri.fsPath.startsWith(root + path.sep);
    });
    return inRepo ? api.toGitUri(uri, 'HEAD') : null;
  } catch { return null; }
}

// ─── the panel ───────────────────────────────────────────────────────────────

const STATUS_LABEL = { working: 'working', input: 'waiting for you', idle: 'idle' };

class LivePanel {
  constructor() {
    this.panel = null;
    this.timer = null;
    this.terminal = null;
    this.lastJson = '';
  }

  show() {
    if (this.panel) { this.panel.reveal(this.panel.viewColumn, true); return; }
    this.panel = vscode.window.createWebviewPanel(
      'claudeHelper.liveSession', 'Live Session',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.iconPath = new vscode.ThemeIcon('pulse');
    this.panel.webview.html = this._html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m) => this._onMessage(m));
    this.panel.onDidDispose(() => {
      this._stop();
      this.panel = null;
      vscode.commands.executeCommand('setContext', 'claudeHelper.livePanelOpen', false);
    });
    this.panel.onDidChangeViewState(() => { if (this.panel && this.panel.visible) this._start(); else this._stop(); });
    vscode.commands.executeCommand('setContext', 'claudeHelper.livePanelOpen', true);
    // The Git extension is lazily activated; without this the first click on a
    // changed file finds no API and downgrades to a plain open.
    try {
      const git = vscode.extensions.getExtension('vscode.git');
      if (git && !git.isActive) git.activate().then(undefined, () => {});
    } catch { /* no git extension here — rows still open their file */ }
    // The terminal that was active when the panel opened is the one it follows;
    // clicking into the webview does not change vscode.window.activeTerminal, so
    // the association stays put until another terminal is focused.
    this.terminal = vscode.window.activeTerminal || null;
    this._start();
  }

  // Called from the activeTerminal event: follow whatever session is in front.
  // A terminal going away (activeTerminal turns undefined) leaves the panel on
  // the last one rather than blanking, which is what you want when the thing you
  // clicked was a file in the other group.
  follow(terminal) {
    if (!this.panel || !terminal || terminal === this.terminal) return;
    this.terminal = terminal;
    this.lastJson = '';
    this._refresh();
  }

  _start() {
    if (this.timer) return;
    this._refresh();
    this.timer = setInterval(() => this._refresh(), 2000);
  }

  _stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // Where a file clicked in the panel should open: the group the terminal is in,
  // which is the one immediately left of the panel. Opening it in the panel's own
  // column would replace the panel with the file.
  _fileColumn() {
    const col = this.panel && this.panel.viewColumn;
    return typeof col === 'number' && col > 1 ? col - 1 : vscode.ViewColumn.One;
  }

  _onMessage(m) {
    if (!m || !m.path) return;
    const uri = vscode.Uri.file(m.path);
    const open = () => vscode.window.showTextDocument(uri, { viewColumn: this._fileColumn(), preview: true })
      .then(undefined, () => vscode.window.showWarningMessage(`Cannot open ${m.path}`));
    if (m.type === 'reveal') { vscode.commands.executeCommand('revealInExplorer', uri); return; }
    if (m.type !== 'diff') { open(); return; }
    // A diff needs the Git extension to have this file's repository open, which it
    // only does for repositories inside the workspace — a session in ~/tasks or in
    // another client's tree is not one of them. `git.openChange` fails SILENTLY
    // there (it resolves, so there is nothing to catch), which makes the row look
    // dead, so the repository is checked first and the file is simply opened when
    // there is none. An untracked file has nothing to diff against either.
    const left = m.status === '??' ? null : gitHeadUri(uri);
    if (!left) { open(); return; }
    vscode.commands.executeCommand('vscode.diff', left, uri,
      `${path.basename(m.path)} (working tree)`,
      { viewColumn: this._fileColumn(), preview: true }).then(undefined, open);
  }

  async _refresh() {
    if (!this.panel || !this.panel.visible) return;
    const state = await this._state();
    const json = JSON.stringify(state);
    if (json === this.lastJson) return;   // nothing moved — don't repaint
    this.lastJson = json;
    try { this.panel.webview.postMessage({ type: 'state', state }); } catch {}
    this.panel.title = state.title ? `Live · ${state.title}` : 'Live Session';
  }

  async _state() {
    const found = resolveSession(this.terminal);
    if (!found) {
      return { empty: true, hint: this.terminal ? 'No Claude session behind this terminal.' : 'Focus a Claude session terminal.' };
    }
    const meta = found.file ? readSessionMeta(found.file) : {};
    const status = found.live ? tabStateWordForSessionStatus(found.live.status) : null;
    const changes = found.cwd ? await gitChanges(found.cwd) : null;
    return {
      title: (found.live && found.live.name) || meta.title || found.sessionId.slice(0, 8),
      sessionId: found.sessionId,
      cwd: found.cwd || '',
      cwdShort: shortHome(found.cwd || ''),
      status,
      statusLabel: status ? STATUS_LABEL[status] : 'not running',
      since: found.live && found.live.statusUpdatedAt ? relativeTime(found.live.statusUpdatedAt) : null,
      changes: changes || (found.file ? touchedFromTranscript(found.file) : []),
      tracked: changes !== null,
      activity: found.file ? readActivity(found.file) : [],
    };
  }

  _html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    margin: 0; padding: 0 0 12px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  /* The panel is deliberately narrow — everything truncates to one line and puts
     the full value in a tooltip rather than wrapping into a wall. */
  .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header { padding: 8px 10px 6px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  #title { font-weight: 600; }
  #cwd { margin-top: 1px; font-size: 11px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  #cwd:hover { color: var(--vscode-textLink-foreground); }
  #status { margin-top: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 5px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-descriptionForeground); }
  .dot.working { background: var(--vscode-charts-blue, #3794ff); animation: pulse 1.4s ease-in-out infinite; }
  .dot.input { background: var(--vscode-list-warningForeground, #cca700); }
  .dot.idle { background: var(--vscode-charts-green, #89d185); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  h2 {
    margin: 0; padding: 8px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; color: var(--vscode-descriptionForeground);
    position: sticky; top: 0; background: var(--vscode-editor-background);
  }
  h2 .n { font-weight: 400; opacity: .7; }
  .row { display: flex; align-items: baseline; gap: 6px; padding: 2px 10px; cursor: default; }
  .row.click { cursor: pointer; }
  .row.click:hover { background: var(--vscode-list-hoverBackground); }
  .code {
    flex: 0 0 auto; width: 16px; font-family: var(--vscode-editor-font-family); font-size: 11px;
    color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-descriptionForeground));
  }
  .code.A, .code.\\3F  { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
  .code.D { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .name { flex: 1 1 auto; min-width: 0; }
  .dir { opacity: .6; }
  .stat { flex: 0 0 auto; font-size: 10px; font-variant-numeric: tabular-nums; opacity: .8; }
  .stat .a { color: var(--vscode-charts-green, #89d185); }
  .stat .d { color: var(--vscode-charts-red, #f14c4c); }
  .label {
    flex: 0 0 auto; max-width: 74px; font-family: var(--vscode-editor-font-family); font-size: 10px;
    color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row.you .text { color: var(--vscode-textLink-foreground); }
  .row.say .text { color: var(--vscode-foreground); }
  .row.tool .text { color: var(--vscode-descriptionForeground); }
  .text { flex: 1 1 auto; min-width: 0; }
  .none { padding: 2px 10px 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  #empty { padding: 14px 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
</style></head><body>
<div id="empty">Waiting for a session…</div>
<div id="main" hidden>
  <header>
    <div id="title" class="ellipsis"></div>
    <div id="cwd" class="ellipsis" title="Reveal in Explorer"></div>
    <div id="status"><span class="dot" id="dot"></span><span id="statustext" class="ellipsis"></span></div>
  </header>
  <h2>Changes <span class="n" id="nchanges"></span></h2>
  <div id="changes"></div>
  <h2>Activity</h2>
  <div id="activity"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text, title) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (title) n.title = title;
    return n;
  };
  const trim = (s, n) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function renderChanges(state) {
    const box = $('changes');
    box.textContent = '';
    $('nchanges').textContent = state.changes.length ? state.changes.length : '';
    if (!state.changes.length) {
      box.appendChild(el('div', 'none', state.tracked ? 'Working tree clean.' : 'No edits recorded.'));
      return;
    }
    for (const c of state.changes) {
      const row = el('div', 'row click');
      row.appendChild(el('span', 'code ' + (c.status || '').slice(0, 1), (c.status || '·').slice(0, 1)));
      const slash = c.rel.lastIndexOf('/');
      const name = el('span', 'name ellipsis', null, c.path);
      if (slash > -1) name.appendChild(el('span', 'dir', c.rel.slice(0, slash + 1)));
      name.appendChild(el('span', null, c.rel.slice(slash + 1)));
      row.appendChild(name);
      if (c.add != null || c.del != null) {
        const stat = el('span', 'stat');
        if (c.add) stat.appendChild(el('span', 'a', '+' + c.add));
        if (c.add && c.del) stat.appendChild(el('span', null, ' '));
        if (c.del) stat.appendChild(el('span', 'd', '−' + c.del));
        row.appendChild(stat);
      }
      row.onclick = () => vscode.postMessage({ type: 'diff', path: c.path, status: c.status });
      box.appendChild(row);
    }
  }

  function renderActivity(state) {
    const box = $('activity');
    box.textContent = '';
    if (!state.activity.length) { box.appendChild(el('div', 'none', 'Nothing yet.')); return; }
    for (const a of state.activity) {
      const row = el('div', 'row ' + a.kind);
      row.appendChild(el('span', 'label', a.kind === 'you' ? 'you' : a.kind === 'say' ? '' : (a.label || ''), a.label || ''));
      row.appendChild(el('span', 'text ellipsis', trim(a.text, 200), a.title || a.text || ''));
      if (a.file) {
        row.classList.add('click');
        row.onclick = () => vscode.postMessage({ type: 'open', path: a.file });
      }
      box.appendChild(row);
    }
  }

  window.addEventListener('message', (e) => {
    const state = e.data && e.data.state;
    if (!state) return;
    if (state.empty) {
      $('main').hidden = true;
      $('empty').hidden = false;
      $('empty').textContent = state.hint || '';
      return;
    }
    $('empty').hidden = true;
    $('main').hidden = false;
    $('title').textContent = state.title;
    $('title').title = state.sessionId;
    $('cwd').textContent = state.cwdShort;
    $('cwd').onclick = () => state.cwd && vscode.postMessage({ type: 'reveal', path: state.cwd });
    $('dot').className = 'dot ' + (state.status || '');
    $('statustext').textContent = state.statusLabel + (state.since ? ' · ' + state.since : '');
    renderChanges(state);
    renderActivity(state);
  });
</script></body></html>`;
  }
}

let livePanel;

function showLivePanel() {
  if (!livePanelEnabled()) {
    vscode.window.showInformationMessage('The Live Session panel is off — set claudeHelper.livePanel to true.');
    return;
  }
  if (!livePanel) livePanel = new LivePanel();
  livePanel.show();
}

function livePanelFollow(terminal) {
  if (livePanel) livePanel.follow(terminal);
}

function disposeLivePanel() {
  if (livePanel && livePanel.panel) livePanel.panel.dispose();
  livePanel = null;
}

module.exports = {
  livePanelEnabled, showLivePanel, livePanelFollow, disposeLivePanel,
  // exported for tests
  resolveSession, readActivity, gitChanges, gitHeadUri, touchedFromTranscript, toolItem, LivePanel,
};
