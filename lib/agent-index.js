const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { claudeAgentsMap, sessionDtachSocket } = require('./session-registry');
const { cfg, expandHome } = require('./shared');
function tmuxHasSession(name) {
  try { return cp.spawnSync('tmux', ['-L', agentSocket(), 'has-session', '-t', name]).status === 0; }
  catch { return false; }
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

// Bridge sessions the index does not know about.
//
// asana-bridge2 deliberately keeps no hand-maintained index — its whole point
// is that `claude agents --json` is the truth — so without this the Agent
// Open Asana Task would simply not find its sessions. Any live session whose cwd
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

module.exports = {
  tmuxHasSession, agentSocket, readAgentIndex, writeAgentIndex, agentSessions,
};
