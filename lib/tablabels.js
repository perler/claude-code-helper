const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { renameTerminalTab } = require('./launch');
const { tabStateKeyForTerminal } = require('./tabstate');

// ─── external tab labels (a shell script relabels a live terminal tab) ──────
//
// tab-names.json (launch.js) only ever puts a name BACK after a window reload —
// nothing outside the extension can put a name on a LIVE tab. This is that
// channel. A shell script drops a text file into a watched directory; the
// extension notices within a couple of seconds and renames the matching tab via
// renameTerminalTab() (the same function repairTabNames() uses — this module
// reimplements none of the actual renaming). Deleting the file restores the
// name the tab had before it was ever labelled.
//
// File presence IS the protocol:
//   ~/.cache/claude-code-helper/tab-labels/<key>  exists, holds "text" -> tab is
//     renamed to "text".
//   ~/.cache/claude-code-helper/tab-labels/<key>  removed -> tab goes back to
//     whatever it was called before the first label was applied.
//
// <key> is exactly what tabStateKeyForTerminal() (tabstate.js) returns for that
// terminal — the CCH_TAB_ID uuid it was launched with, or the cwd-hash fallback
// for a terminal that predates CCH_TAB_ID / was attached rather than launched.
// Using the same function the badges resolve through means a label and a badge
// can never disagree about which tab they mean, and it is the one place a
// caller (the CLI side of this feature) needs to read a key from — see
// readme.md for how a shell script gets it for a given shell pid.
function tabLabelsDir() { return path.join(os.homedir(), '.cache', 'claude-code-helper', 'tab-labels'); }

function tabLabelBasesFile() { return path.join(os.homedir(), '.cache', 'claude-code-helper', 'tab-label-bases.json'); }

// A key is either a CCH_TAB_ID uuid or the tabstate cwd-hash fallback (see
// tabStateCwdKey() in tabstate.js — 'cwd-' + a 40-char sha1 hex digest). Nothing
// else is a filename this extension's own key function would ever produce, so
// anything else sitting in the directory (a stray editor swap file, a typo) is
// ignored rather than acted on.
function isPlausibleLabelKey(name) {
  return /^[0-9a-f-]{36}$/.test(name) || /^cwd-[0-9a-f]{40}$/.test(name);
}

// The same transform renameTerminalTab() applies to whatever name it's handed —
// done here too, BEFORE deciding whether a rename is even needed, so "does the
// label differ from terminal.name" compares like with like, and a file holding
// only whitespace (or nothing) reads as "no label" rather than a rename to "".
function sanitizeLabelText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function readLabelBases() {
  try { return JSON.parse(fs.readFileSync(tabLabelBasesFile(), 'utf8')); } catch { return {}; }
}

// Same shape and 14-day pruning as rememberTabName() in launch.js: one entry per
// currently-labelled tab, so a key whose terminal closed (or whose label file
// was removed) without ever being re-read doesn't sit in the file forever.
function writeLabelBases(bases) {
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(bases)) if (!v || !(v.at > cutoff)) delete bases[k];
  try {
    fs.mkdirSync(path.dirname(tabLabelBasesFile()), { recursive: true });
    fs.writeFileSync(tabLabelBasesFile(), JSON.stringify(bases));
  } catch {}
}

// The directory, read into key -> sanitized label. Anything that isn't a
// plausible key, or that sanitizes to nothing, is dropped rather than acted on.
function readTabLabels() {
  const dir = tabLabelsDir();
  const out = new Map();
  let files;
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!isPlausibleLabelKey(f)) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const label = sanitizeLabelText(raw);
    if (label) out.set(f, label);
  }
  return out;
}

// What we last renamed each tab to, so a hand-typed rename can be told apart
// from a tab that has simply not been labelled yet. In memory only: after a
// window reload the label file is authoritative again, which is what we want —
// a reload is exactly when VS Code mangles names and the label must go back on.
const applied = new Map();

// One pass: apply every label file, restore every base whose label file is gone.
// Terminals are processed SEQUENTIALLY — one `for...of` with an `await` inside
// it, never `Promise.all`/`.map()`. renameTerminalTab()'s own comment documents
// why: firing several renames concurrently races vscode.window.activeTerminal
// and can swap two tabs' names (the 2026-09-04 incident). A caller renaming
// several terminals per tick, which this one does, hits that hazard just as
// hard as the reload-time sweep that surfaced it.
async function applyTabLabelsOnce() {
  const labels = readTabLabels();
  const bases = readLabelBases();
  let basesChanged = false;
  for (const terminal of vscode.window.terminals) {
    if (terminal.exitStatus) continue;
    let key;
    try { key = tabStateKeyForTerminal(terminal); } catch { key = null; }
    // No key yet means the shell's pid hasn't resolved — same reasoning as
    // repairTabNames(): a later tick, run every ~1.5s, picks it up.
    if (!key) continue;
    const want = labels.get(key);
    if (want) {
      // Do not fight a rename typed by hand. If we already applied exactly this
      // label and the tab no longer carries it, a human changed it in the tab's
      // context menu — the label file has not moved, so re-applying every 1.5s
      // would undo their edit on a loop. Same instinct as repairTabNames()'s
      // once-per-window WeakSet, keyed on the label instead of the window: a
      // NEW value in the file still applies, because it differs from what we
      // last set.
      if (applied.get(key) === want && terminal.name !== want) continue;
      // Record the name the tab had BEFORE any label touched it — but only the
      // first time, so a script that writes several labels in a row (or two
      // ticks that both see the same label) doesn't overwrite the true
      // original with an intermediate labelled name.
      if (!bases[key]) { bases[key] = { name: terminal.name, at: Date.now() }; basesChanged = true; }
      if (want !== terminal.name) await renameTerminalTab(terminal, want);
      applied.set(key, want);
    } else if (bases[key]) {
      applied.delete(key);
      const original = bases[key].name;
      delete bases[key];
      basesChanged = true;
      if (original && original !== terminal.name) await renameTerminalTab(terminal, original);
    }
  }
  if (basesChanged) writeLabelBases(bases);
}

// Concurrency guard: a poll tick and an fs.watch tick can land while the
// previous pass is still mid-await (renameTerminalTab() itself waits up to 1s
// per rename), and running two passes over the same terminal list at once is
// exactly the concurrent-rename hazard the sequential loop above exists to
// avoid. A tick that arrives mid-pass is folded into a single rerun right after
// the current one finishes, rather than queued up one per event.
let applyRunning = false;
let rerunQueued = false;

function scheduleApplyTabLabels() {
  if (applyRunning) { rerunQueued = true; return; }
  applyRunning = true;
  applyTabLabelsOnce().catch(() => {}).then(() => {
    applyRunning = false;
    if (rerunQueued) { rerunQueued = false; scheduleApplyTabLabels(); }
  });
}

let watchDebounce;

// Same belt-and-braces shape as startTabStateWatcher() in tabstate.js: fs.watch
// for a fast reaction, plus a periodic poll because a lone fs.watch has already
// been seen to miss events on this box (see that function's own comment) — a
// stale label is worse than a slightly-late one. Must survive the directory not
// existing yet (a fresh checkout, or a caller that hasn't run once) and survive
// it disappearing later (an `rm -rf` of the cache dir): the watch is re-armed
// from inside the poll rather than only at startup, so losing the directory
// only ever costs the ~1.5s until the next poll tick, never the watcher for
// good.
function startTabLabelWatcher(context) {
  const dir = tabLabelsDir();
  let watcher = null;
  const arm = () => {
    if (watcher) return;
    try {
      watcher = fs.watch(dir, () => {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(scheduleApplyTabLabels, 150);
      });
      watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; });
    } catch { /* dir missing or unwatchable right now — the poll below still covers it */ }
  };
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  arm();
  scheduleApplyTabLabels(); // pick up a label file that was already sitting there at activation
  const poll = setInterval(() => {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    arm();
    scheduleApplyTabLabels();
  }, 1500);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(poll);
      clearTimeout(watchDebounce);
      if (watcher) { try { watcher.close(); } catch {} }
    },
  });
}

module.exports = {
  tabLabelsDir, tabLabelBasesFile, isPlausibleLabelKey, sanitizeLabelText,
  readLabelBases, writeLabelBases, readTabLabels, applyTabLabelsOnce,
  scheduleApplyTabLabels, startTabLabelWatcher,
};
