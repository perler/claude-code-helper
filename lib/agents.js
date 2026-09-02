const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  agentAttachable, agentLive, agentSessions, agentSocket, agentStatus, bridgeRunInFlight, readAgentHistory, readAgentIndex, writeAgentHistory, writeAgentIndex,
} = require('./agent-index');
const { dtachAttachCmd, dtachStealCmd, launchClaude, moveTerminalTabToEnd } = require('./launch');
const { providers } = require('./providers');
const { claudeAgentsMap, registerSessionTerminal } = require('./session-registry');
const {
  buildTooltip, dtachSocketDir, encodeProjectDir, readSessionMeta, relativeTime, shortHome,
} = require('./shared');
const AGENT_STATUS_GLYPH = {
  busy: '🟢', idle: '🔵', waiting: '🟠', blocked: '🔴', unknown: '🟢',
};

function agentStatusGlyph(entry, live) {
  if (!live) return '⚫';
  return AGENT_STATUS_GLYPH[agentStatus(entry)] || '🟢';
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
      ? vscode.Uri.file(path.join(__dirname, '..', 'resources', 'asana.svg'))
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

function removeAgentEntry(node) {
  if (!node || !node.entry) return;
  forgetAgentSession(node.entry);
  providers.agent.refresh();
}

// ─── bookmarks ───────────────────────────────────────────────────────────────

module.exports = {
  AGENT_STATUS_GLYPH, agentStatusGlyph, forgetAgentSession, agentSessionFile, buildAgentTooltip,
  AgentSessionsProvider, attachAgentSession, resumeAgentSession, removeAgentEntry,
};
