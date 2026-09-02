const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { cfg, dtachSocketDir } = require('./shared');
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

module.exports = {
  claudeAgentsMap, liveSessionIds, sessionTerminals, registerSessionTerminal,
  sessionAttachedHere, liveDtachSocketPaths, sessionDtachSocket,
};
