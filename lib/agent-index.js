const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { claudeAgentsMap } = require('./session-registry');
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

// Bridge sessions the index does not know about.
//
// asana-bridge2 deliberately keeps no hand-maintained index — its whole point
// is that `claude agents --json` is the truth — so Open Asana Task finds its
// sessions here. Any live session whose cwd holds an `.asana-claude.json` marker is a bridge task session, and the marker
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
      permalink: marker.taskGid ? `https://app.asana.com/0/0/${marker.taskGid}` : null,
      source: 'bridge2',
      createdAt: marker.createdAt || (a.startedAt ? new Date(a.startedAt).toISOString() : null),
    });
  }
  return out;
}

// Helper-launched tmux entries (the index) plus the live bridge-v2 sessions
// found through `claude agents --json`. A discovered entry fills gaps only: an
// index entry for the same session keeps its fields.
function agentSessions() {
  const byId = new Map();
  for (const e of readAgentIndex()) if (e && e.sessionId) byId.set(e.sessionId, e);
  for (const e of discoveredAgentSessions()) {
    byId.set(e.sessionId, { ...e, ...byId.get(e.sessionId) });
  }
  return [...byId.values()];
}

module.exports = {
  tmuxHasSession, agentSocket, readAgentIndex, writeAgentIndex, agentSessions,
};
