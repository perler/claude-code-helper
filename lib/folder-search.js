const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { addFavouriteFromUri } = require('./favourites');
const {
  favFromUri, moveTerminalTabToEnd, newFolderAndStartClaudeFromUri, startClaude,
} = require('./launch');
const { cfg, expandHome, shortHome } = require('./shared');
function folderSearchRoots() {
  const raw = cfg().get('folderSearchRoots');
  const list = Array.isArray(raw) && raw.length ? raw : ['~/clients', '~/projects'];
  return list.map(expandHome).filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

// `fd` walks a deep tree far faster than `find`; Debian ships it as `fdfind`.
let fdBinCache;

function fdBinary() {
  if (fdBinCache !== undefined) return fdBinCache;
  fdBinCache = null;
  for (const bin of ['fd', 'fdfind']) {
    try {
      cp.execFileSync(bin, ['--version'], { stdio: 'ignore' });
      fdBinCache = bin;
      break;
    } catch { /* not installed */ }
  }
  return fdBinCache;
}

function scanDirs(root, depth, excludes) {
  return new Promise((resolve) => {
    const fd = fdBinary();
    const [bin, args] = fd
      ? [fd, ['--type', 'd', '--no-ignore', '--max-depth', String(depth),
              ...excludes.flatMap((e) => ['--exclude', e]), '.', root]]
      // find has no --exclude; prune the excluded names (and every dotdir) instead.
      : ['find', [root, '-mindepth', '1', '-maxdepth', String(depth),
                  '(', '-name', '.*', ...excludes.flatMap((e) => ['-o', '-name', e]), ')',
                  '-prune', '-o', '-type', 'd', '-print']];
    let out = '';
    let child;
    try {
      child = cp.spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return resolve([]); }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve([]));
    // fd exits 1 when nothing matched — take whatever came out either way.
    child.on('close', () => resolve(out.split('\n').map((s) => s.replace(/\/$/, '')).filter(Boolean)));
  });
}

async function listFolders() {
  const roots = folderSearchRoots();
  if (!roots.length) return [];
  const depth = Math.max(1, Number(cfg().get('folderSearchDepth')) || 3);
  const raw = cfg().get('folderSearchExcludes');
  const excludes = Array.isArray(raw) ? raw : ['node_modules', '.git', 'venv', '.venv', 'dist', 'build'];
  const lists = await Promise.all(roots.map((r) => scanDirs(r, depth, excludes)));
  const seen = new Set();
  const dirs = [];
  for (const p of lists.flat()) {
    if (seen.has(p)) continue;
    seen.add(p);
    dirs.push(p);
  }
  return dirs.sort();
}

// What Enter does, and what the per-item buttons offer. Keys are the values of
// the claudeHelper.folderSearchAction setting.
const FOLDER_ACTIONS = {
  openFolder: {
    icon: 'folder-opened', label: 'Open Folder in New Window',
    run: (p) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true }),
  },
  terminal: {
    icon: 'terminal', label: 'Open Terminal Here',
    run: (p) => {
      const t = vscode.window.createTerminal({ name: path.basename(p), cwd: p });
      t.show();
      moveTerminalTabToEnd();
    },
  },
  startClaude: {
    icon: 'rocket', label: 'Start Claude Here',
    run: (p) => startClaude(favFromUri(vscode.Uri.file(p))),
  },
  newFolder: {
    icon: 'new-folder', label: 'New Subfolder & Start Claude',
    run: (p) => newFolderAndStartClaudeFromUri(vscode.Uri.file(p)),
  },
  reveal: {
    icon: 'eye', label: 'Reveal in Explorer',
    // revealInExplorer silently does nothing for a path outside every open root,
    // and the search roots are deliberately wider than the workspace — so say so
    // and offer the two ways in rather than swallowing the keypress.
    run: async (p) => {
      const uri = vscode.Uri.file(p);
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        const pick = await vscode.window.showWarningMessage(
          `${shortHome(p)} is outside the open workspace.`,
          'Add to Workspace', 'Open in New Window');
        if (pick === 'Add to Workspace') {
          vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, null, { uri });
        } else if (pick === 'Open in New Window') {
          vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        }
        return;
      }
      await vscode.commands.executeCommand('revealInExplorer', uri);
    },
  },
  favourite: {
    icon: 'star-add', label: 'Add to Favourites',
    run: (p, ctx) => addFavouriteFromUri(ctx, vscode.Uri.file(p), { askLabel: false }),
  },
};

// A QuickPick cannot see key chords itself, so the Ctrl+Enter shortcut arrives
// as a normal command and needs a handle on the picker that is currently open.
let folderSearchOpen = null;   // { dir, run } while visible, null otherwise
// Read by the New Subfolder command, which fires while the pick is still on screen.
function currentFolderSearch() { return folderSearchOpen; }

async function goToFolder(ctx) {
  const defaultKey = FOLDER_ACTIONS[cfg().get('folderSearchAction')] ? cfg().get('folderSearchAction') : 'openFolder';
  const buttons = Object.entries(FOLDER_ACTIONS)
    .filter(([key]) => key !== defaultKey)
    .map(([key, a]) => ({ key, iconPath: new vscode.ThemeIcon(a.icon), tooltip: a.label }));

  const qp = vscode.window.createQuickPick();
  qp.placeholder = `Folder name… (Enter: ${FOLDER_ACTIONS[defaultKey].label} · Ctrl+Enter: New Subfolder & Start Claude)`;
  qp.matchOnDescription = true;
  qp.busy = true;
  let alive = true;
  const setOpenContext = (v) =>
    vscode.commands.executeCommand('setContext', 'claudeHelper.folderSearchOpen', v);
  qp.onDidHide(() => {
    alive = false;
    folderSearchOpen = null;
    setOpenContext(false);
    qp.dispose();
  });

  const run = (key, dir) => {
    qp.hide();
    Promise.resolve(FOLDER_ACTIONS[key].run(dir, ctx)).catch((e) =>
      vscode.window.showErrorMessage(`Claude Code Helper: ${e && e.message ? e.message : e}`));
  };
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    if (item) run(defaultKey, item.dir);
  });
  qp.onDidTriggerItemButton((e) => run(e.button.key, e.item.dir));
  qp.onDidChangeActive((items) => {
    if (folderSearchOpen) folderSearchOpen.dir = items[0] ? items[0].dir : null;
  });
  folderSearchOpen = { dir: null, run };
  setOpenContext(true);
  qp.show();

  const dirs = await listFolders();
  if (!alive) return;
  if (!dirs.length) {
    qp.hide();
    vscode.window.showWarningMessage(
      `Claude Code Helper: nothing to search. Check claudeHelper.folderSearchRoots (${(cfg().get('folderSearchRoots') || []).join(', ') || 'unset'}).`);
    return;
  }
  qp.items = dirs.map((d) => ({
    label: path.basename(d),
    description: shortHome(path.dirname(d)),
    dir: d,
    buttons,
  }));
  qp.busy = false;
}

// ─── activation ──────────────────────────────────────────────────────────────

module.exports = {
  folderSearchRoots, fdBinary, scanDirs, listFolders, FOLDER_ACTIONS,
  currentFolderSearch, goToFolder,
};
