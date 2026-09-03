const vscode = require('vscode');

const { asanaTaskFor } = require('./asana');
const { sessionTerminals } = require('./session-registry');
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

// The editor tab context menu hands a command two things: the tab's resource URI —
// `vscode-terminal:/<workspaceId>/<instanceId>`, whose instance id nothing in the
// extension API maps back to a Terminal — and `{ groupId, editorIndex }`. The index
// is the usable half: it finds the Tab, whose label is the terminal's title, and that
// title is matched against the open terminals. (The URI's fragment holds the title at
// construction time, which is empty for a terminal restored across a window reload,
// so it is not used.) Returns a Terminal, an array when several could be meant, or
// null when nothing matches — never a silent guess at the active one, which reveals
// the wrong folder.
function terminalFromTabArg(arg, ctx) {
  // terminal/title/context (the panel's tab list) hands the terminal itself.
  if (arg && typeof arg.sendText === 'function') return arg;

  const idx = ctx && typeof ctx.editorIndex === 'number' ? ctx.editorIndex : -1;
  const labels = new Set();
  if (idx >= 0) {
    for (const g of vscode.window.tabGroups.all) {
      const tab = g.tabs[idx];
      if (tab && tab.input instanceof vscode.TabInputTerminal && tab.label) labels.add(tab.label);
    }
  }
  const named = (t) => [(t.name || ''), (t.creationOptions && t.creationOptions.name) || ''];
  let hits = labels.size
    ? vscode.window.terminals.filter((t) => named(t).some((n) => n && labels.has(n)))
    : [];
  if (!hits.length) hits = vscode.window.terminals.slice();   // ask rather than guess

  if (hits.length === 1) return hits[0];
  if (!hits.length) return null;
  // Same name in the same folder is the same answer either way.
  const paths = new Set(hits.map((t) => { const c = getTerminalCwd(t); return c ? c.fsPath : ''; }));
  if (paths.size === 1) return hits[0];
  return hits;
}

module.exports = {
  sessionIdForTerminal, terminalAsanaTask, findReusableTerminal, getTerminalCwd, terminalFromTabArg,
};
