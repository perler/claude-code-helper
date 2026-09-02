const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { cfg, expandHome } = require('./shared');
function bookmarksFile() {
  const configured = (cfg().get('bookmarksFile') || '').trim();
  if (configured) return expandHome(configured);
  return path.join(os.homedir(), '.config', 'cc-bookmarks.json');
}

function readBookmarks() {
  const file = bookmarksFile();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fs.existsSync(file)) console.error(`Claude Code Helper: failed to read ${file} — ${e.message}`);
    return [];
  }
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

function writeBookmarks(bookmarks) {
  const file = bookmarksFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Code Helper: ${e.message}`);
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ bookmarks }, null, 2));
}

function ensureBookmarksFile() {
  const file = bookmarksFile();
  if (!fs.existsSync(file)) writeBookmarks([]);
  return file;
}

class BookmarksProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() { this._em.fire(); }
  getTreeItem(bm) {
    const item = new vscode.TreeItem(bm.label, vscode.TreeItemCollapsibleState.None);
    item.tooltip = bm.url;
    item.description = bm.url;
    item.iconPath = new vscode.ThemeIcon(bm.icon || 'globe');
    item.contextValue = 'bookmark';
    item.command = { command: 'claudeHelper.openBookmark', title: 'Open', arguments: [bm] };
    return item;
  }
  getChildren() { return readBookmarks(); }
}

let bookmarksProvider;
function setBookmarksProvider(p) { bookmarksProvider = p; }

// Fetch a URL server-side (extension host is Node), following redirects and
// carrying cookies across them (so token-auth pages like /auto?k=… that 302 to /
// keep their session cookie). Returns { body, finalUrl }.
function httpGetText(rawUrl, { redirects = 5, cookies = '' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const req = mod.request(u, {
      method: 'GET',
      headers: {
        'User-Agent': 'claude-code-helper',
        Accept: 'text/html,application/xhtml+xml,*/*',
        ...(cookies ? { Cookie: cookies } : {}),
      },
    }, (res) => {
      const setCookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
      const merged = [cookies, setCookie].filter(Boolean).join('; ');
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return resolve(httpGetText(next, { redirects: redirects - 1, cookies: merged }));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Inject a <base> (so any relative refs resolve to the real origin) and a CSP that
// permits the panel's own inline <style>/<script> plus https resources + XHRs.
function prepBookmarkHtml(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const base = `<base href="${origin}/">`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri ${origin}; img-src https: data: blob:; media-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; script-src 'unsafe-inline' https:; connect-src https:;">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${base}\n${csp}`);
  return `${base}\n${csp}\n${html}`;
}

// Panels opened via the native-webview path, keyed by URL so a re-click reveals
// the existing tab instead of spawning duplicates.
const bookmarkPanels = new Map();

async function openBookmarkWebview(bm) {
  const existing = bookmarkPanels.get(bm.url);
  if (existing) { existing.reveal(); return; }
  let fetched;
  try {
    fetched = await httpGetText(bm.url);
  } catch (e) {
    vscode.window.showWarningMessage(`Bookmark "${bm.label}": can't render in-editor (${e.message}); opening in Simple Browser.`);
    await vscode.commands.executeCommand('simpleBrowser.show', bm.url);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'claudeHelperBookmark', bm.label || 'Bookmark', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = prepBookmarkHtml(fetched.body, fetched.finalUrl);
  bookmarkPanels.set(bm.url, panel);
  panel.onDidDispose(() => { if (bookmarkPanels.get(bm.url) === panel) bookmarkPanels.delete(bm.url); });
}

// render mode per bookmark (cc-bookmarks.json "render" field):
//   "webview" — rendered as a real VS Code webview tab (Cmd+W closes the tab, not
//               the PWA). Best for self-contained panels served with a token.
//   "browser" — opened as a normal external browser tab (openExternal).
//   "simple"  — VS Code Simple Browser (default; handles arbitrary sites). Note its
//               content is a cross-origin iframe, so Cmd+W with focus inside it is
//               swallowed by the browser and can close the whole PWA window.
async function openBookmark(bm) {
  if (!bm || !bm.url) {
    vscode.window.showErrorMessage('No bookmark URL.');
    return;
  }
  const mode = bm.render || 'simple';
  if (mode === 'webview') return openBookmarkWebview(bm);
  if (mode === 'browser') return vscode.env.openExternal(vscode.Uri.parse(bm.url));
  await vscode.commands.executeCommand('simpleBrowser.show', bm.url);
}

async function addBookmark() {
  const url = await vscode.window.showInputBox({
    title: 'Add Bookmark',
    prompt: 'Bookmark URL',
    placeHolder: 'https://example.com',
    validateInput: (v) => (/^https?:\/\//i.test(v.trim()) ? undefined : 'URL must start with http:// or https://'),
  });
  if (url === undefined) return;
  let defaultLabel = url.trim();
  try { defaultLabel = new URL(url.trim()).hostname; } catch {}
  const label = await vscode.window.showInputBox({
    title: 'Add Bookmark',
    prompt: 'Label',
    value: defaultLabel,
  });
  if (label === undefined) return;
  const bookmarks = readBookmarks();
  bookmarks.push({ label: label.trim() || defaultLabel, url: url.trim() });
  writeBookmarks(bookmarks);
  bookmarksProvider.refresh();
  vscode.window.showInformationMessage(`Bookmark "${label.trim() || defaultLabel}" added.`);
}

async function editBookmark(bm) {
  if (!bm) return;
  const label = await vscode.window.showInputBox({
    title: 'Edit Bookmark',
    prompt: 'Label',
    value: bm.label,
  });
  if (label === undefined) return;
  const url = await vscode.window.showInputBox({
    title: 'Edit Bookmark',
    prompt: 'Bookmark URL',
    value: bm.url,
    validateInput: (v) => (/^https?:\/\//i.test(v.trim()) ? undefined : 'URL must start with http:// or https://'),
  });
  if (url === undefined) return;
  const bookmarks = readBookmarks();
  const idx = bookmarks.findIndex((b) => b.label === bm.label && b.url === bm.url);
  if (idx === -1) return;
  bookmarks[idx] = { ...bookmarks[idx], label: label.trim() || bm.label, url: url.trim() };
  writeBookmarks(bookmarks);
  bookmarksProvider.refresh();
}

async function removeBookmark(bm) {
  if (!bm) return;
  const c = await vscode.window.showWarningMessage(
    `Remove bookmark "${bm.label}"?`, { modal: true }, 'Remove'
  );
  if (c !== 'Remove') return;
  const bookmarks = readBookmarks().filter((b) => !(b.label === bm.label && b.url === bm.url));
  writeBookmarks(bookmarks);
  bookmarksProvider.refresh();
}

// ─── go to folder ────────────────────────────────────────────────────────────
//
// Quick Open (Ctrl+P) indexes files only — VS Code has no way to jump to a
// FOLDER by name. This is that picker: it scans a handful of roots for
// directories and hands the pick to the same actions the favourites tree uses.

module.exports = {
  bookmarksFile, readBookmarks, writeBookmarks, ensureBookmarksFile, BookmarksProvider,
  setBookmarksProvider, httpGetText, prepBookmarkHtml, bookmarkPanels, openBookmarkWebview,
  openBookmark, addBookmark, editBookmark, removeBookmark,
};
