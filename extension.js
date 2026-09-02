const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { agentIndexFile, agentSocket } = require('./lib/agent-index');
const {
  AgentSessionsProvider, attachAgentSession, removeAgentEntry, resumeAgentSession,
} = require('./lib/agents');
const { asanaTaskFor, openAsanaTask, refreshAsanaProjects } = require('./lib/asana');
const {
  BookmarksProvider, addBookmark, setBookmarksProvider, editBookmark, ensureBookmarksFile, openBookmark, removeBookmark,
} = require('./lib/bookmarks');
const {
  FavouritesProvider, addFavouriteFromUri, setFavProvider, getFavs, removeFavourite, setFavs,
} = require('./lib/favourites');
const { currentFolderSearch, goToFolder } = require('./lib/folder-search');
const {
  launchClaude, moveTerminalTabToEnd, newFolderAndStartClaudeFromUri, newScratchSession, redrawDtachSessions, resumeClaude, resumeClaudeFromUri, startClaude, startClaudeFromUri, sweepScratchRenames,
} = require('./lib/launch');
const { AskViewProvider } = require('./lib/newtask');
const { providers } = require('./lib/providers');
const { sessionTerminals } = require('./lib/session-registry');
const {
  SessionsProvider, setExtCtx, getSessionCwd, hiddenSessions, resumeSessionNode, setHiddenSessions,
} = require('./lib/sessions');
const { cfg, dtachSocketDir } = require('./lib/shared');
const {
  createTabStateProvider, startTabStateWatcher, tabStateSeedTerminals, tabStateSweepStale, tabStateTerminalClosed, tabStateTerminalFocused, tabStateTerminalOpened,
} = require('./lib/tabstate');
const { TerminalsProvider, getTerminalCwd, terminalAsanaTask } = require('./lib/terminals');
let agentProvider;
let favProvider;
let bookmarksProvider;

let sessProvider; // module-level so launchClaude can nudge Recent Sessions after a launch

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
  setExtCtx(context);
  applyFastHoverOnce(context);
  vscode.commands.executeCommand('setContext', 'claudeHelper.hasHiddenSessions', hiddenSessions().size > 0);

  // Tab state decorations — see the "tab state decorations" section above.
  tabStateSeedTerminals();
  const tabStateProvider = createTabStateProvider();
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
  setFavProvider(favProvider);
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
  providers.sess = sessProvider;
  context.subscriptions.push(sessView);

  agentProvider = new AgentSessionsProvider();
  const agentView = vscode.window.createTreeView('claudeHelper.agentSessions', {
    treeDataProvider: agentProvider, showCollapseAll: false,
  });
  agentProvider.view = agentView;
  providers.agent = agentProvider;
  context.subscriptions.push(agentView);

  bookmarksProvider = new BookmarksProvider();
  setBookmarksProvider(bookmarksProvider);
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
    const open = currentFolderSearch();
    if (open && open.dir) open.run('newFolder', open.dir);
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

module.exports = {
  activate, deactivate,
};
