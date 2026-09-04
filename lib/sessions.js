const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { asanaTaskFor, asanaTasks } = require('./asana');
const { launchClaude, launchClaudeDtach } = require('./launch');
const { liveSessionIds, sessionAttachedHere, sessionDtachSocket } = require('./session-registry');
const {
  buildSessionTooltip, cfg, decodeProjectFolder, expandHome, readSessionMeta, relativeTime,
} = require('./shared');

// Throwaway cwds (scratchpads, the nightly learn-scan's mktemp dirs) spawn dozens
// of sessions a day and drown the real ones. A project folder is the cwd with
// "/" → "-", so an excluded path is matched on the encoded name — no readdir, no
// transcript parsing for a whole tree we're going to drop anyway.
function excludedFolderTest() {
  const encoded = (cfg().get('sessionsExcludePaths', ['/tmp']) || [])
    .map((p) => expandHome(String(p).trim()).replace(/\/+$/, ''))
    .filter(Boolean)
    .map((p) => p.replace(/\//g, '-'));
  return (folder) => encoded.some((e) => folder === e || folder.startsWith(`${e}-`));
}

function scanRecentSessions() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const maxAgeMs = (cfg().get('sessionsMaxAgeDays', 7) || 7) * 24 * 3600 * 1000;
  const maxItems = cfg().get('sessionsMaxItems', 100) || 100;
  const cutoff = Date.now() - maxAgeMs;
  let projects;
  try { projects = fs.readdirSync(root); } catch { return []; }
  const out = [];
  const isExcluded = excludedFolderTest();
  for (const proj of projects) {
    if (isExcluded(proj)) continue;
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

// Two same-titled sessions living in different folders are indistinguishable in
// the tree, so a stale one can be retired: "Hide Session" drops the row but
// leaves the transcript on disk (still resumable from the CLI, and restorable
// here via "Show Hidden Sessions"). "Delete Session" is the destructive sibling
// — it unlinks the .jsonl and the session is gone for good. Session ids are
// uuids, so a flat id list is enough to key the hidden set.
const HIDDEN_KEY = 'claudeHelper.hiddenSessions';

let extCtx = null;
// activate() owns the extension context; this is how it reaches the hidden-session store.
function setExtCtx(ctx) { extCtx = ctx; }

function hiddenSessions() {
  return new Set(extCtx ? extCtx.globalState.get(HIDDEN_KEY, []) : []);
}

async function setHiddenSessions(set) {
  await extCtx.globalState.update(HIDDEN_KEY, [...set]);
  vscode.commands.executeCommand('setContext', 'claudeHelper.hasHiddenSessions', set.size > 0);
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

module.exports = {
  scanRecentSessions, HIDDEN_KEY, hiddenSessions, setHiddenSessions, getSessionCwd,
  bucketFor, setExtCtx, SessionsProvider, resumeSessionNode,
};
