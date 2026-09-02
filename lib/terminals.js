const vscode = require('vscode');
const path = require('path');

const { asanaTaskFor, asanaTasks } = require('./asana');
const { sessionTerminals } = require('./session-registry');
const { buildTooltip, cfg, listSessions, readSessionMeta, relativeTime, shortHome } = require('./shared');
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

module.exports = {
  buildTerminalTooltip, SHELL_NAMES, terminalDisplayName, sessionIdForTerminal, terminalAsanaTask,
  findReusableTerminal, getTerminalCwd, TerminalsProvider,
};
