const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const { agentSessions } = require('./agent-index');
const { cfg, expandHome } = require('./shared');
function asanaCommand() { return expandHome((cfg().get('asanaCommand') || '').trim()); }

function asanaCacheFile() { return path.join(os.homedir(), '.cache', 'claude-code-helper', 'asana-projects.json'); }

// `asana projects` prints a grouped text list: "   • BF EDV" then "     ID: 620…".
function parseAsanaProjects(stdout) {
  const out = [];
  let name = null;
  for (const line of String(stdout || '').split('\n')) {
    const n = line.match(/^\s*•\s+(.*\S)\s*$/);
    if (n) { name = n[1]; continue; }
    const id = line.match(/^\s*ID:\s*(\d+)\s*$/);
    if (id && name) { out.push({ name, gid: id[1] }); name = null; }
  }
  return out;
}

function loadAsanaProjects() {
  try { return JSON.parse(fs.readFileSync(asanaCacheFile(), 'utf8')); } catch { return []; }
}

// Fire-and-forget: a stale list still routes correctly, an absent one only costs the
// Asana half of the decision, so nothing here is worth blocking or reporting on.
function refreshAsanaProjects(maxAgeHours) {
  const cmd = asanaCommand();
  if (!cmd) return;
  const file = asanaCacheFile();
  if (maxAgeHours) {
    try {
      if ((Date.now() - fs.statSync(file).mtimeMs) < maxAgeHours * 3600e3) return;
    } catch {}
  }
  const tokens = cmd.split(/\s+/);
  try {
    cp.execFile(tokens[0], [...tokens.slice(1), 'projects'], { timeout: 30000, maxBuffer: 1 << 22 }, (err, stdout) => {
      if (err) return;
      const list = parseAsanaProjects(stdout);
      if (!list.length) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list));
      } catch {}
    });
  } catch {}
}

// ── the queue buttons ────────────────────────────────────────────────────────
//
// A sidebar webview cannot shrink to its content: the New Task view keeps whatever
// height the sidebar gives it, so everything below the hint line is blank space we
// cannot reclaim. The queue buttons live there, which is why they cost the box
// nothing. Each one starts an ordinary session whose first prompt hands the
// inbox-zero skill a scope. The count is on the button so a zero saves the click.

const QUEUE_SCOPES = [
  { id: 'today', label: 'Today', prompt: '/inbox-zero today' },
  { id: 'input', label: '\u23f3 Input', prompt: '/inbox-zero input' },
  { id: 'high', label: '\ud83d\udd25 High', prompt: '/inbox-zero high' },
];

function queueCountsFile() { return path.join(os.homedir(), '.cache', 'claude-code-helper', 'queue-counts.json'); }

function loadQueueCounts() {
  try { return JSON.parse(fs.readFileSync(queueCountsFile(), 'utf8')); } catch { return {}; }
}

// One `asana queue <scope> --count` per button, in parallel, cached on disk. The
// number is a hint and never a gate — a stale or missing count still leaves the
// button working — so nothing here blocks, retries or reports. A scope whose call
// fails simply keeps no entry, and its button shows a dash rather than a wrong
// number, which is the one thing a count on a button must never do.
function refreshQueueCounts(maxAgeMs, done) {
  const cmd = asanaCommand();
  if (!cmd) return;
  const file = queueCountsFile();
  if (maxAgeMs) {
    try { if ((Date.now() - fs.statSync(file).mtimeMs) < maxAgeMs) return; } catch {}
  }
  const tokens = cmd.split(/\s+/);
  const counts = {};
  let left = QUEUE_SCOPES.length;
  const finish = () => {
    if (--left) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(counts));
    } catch {}
    if (done) { try { done(counts); } catch {} }
  };
  for (const s of QUEUE_SCOPES) {
    try {
      cp.execFile(tokens[0], [...tokens.slice(1), 'queue', s.id, '--count'], { timeout: 30000 }, (err, stdout) => {
        // `--count` prints the bare integer, or "100+" when the search hit Asana's
        // page cap. Both are display strings here, so neither is parsed as a number.
        const v = String(stdout || '').trim();
        if (!err && /^\d+\+?$/.test(v)) counts[s.id] = v;
        finish();
      });
    } catch { finish(); }
  }
}

// The box is usually typed "asana <subject>" / "email <subject>". The verb is the box's
// grammar, not part of the task's name.
function asanaTaskQuery(q) {
  return String(q || '').trim().replace(/^(asana|email)\s+/i, '').trim();
}

// The other thing typed in front of a pasted task name is the client: "rah 4. Final Local
// Folders copy". That word is addressing, not part of the name, and leaving it in breaks
// the exact match that the whole lookup rests on — the entry then reaches the model as a
// bare string and gets matched on wordplay. Only a token that IS one of our shortcodes is
// dropped, and the original spelling stays a candidate, so a task genuinely named after a
// client still matches.
function asanaTaskNames(question, targets) {
  const base = asanaTaskQuery(question);
  const names = [base];
  const codes = new Set(HOUSE_PROJECTS.map((h) => h.code).filter(Boolean).map((c) => c.toUpperCase()));
  for (const t of targets) {
    const m = /^client:(.+)$/i.exec(t.id || '');
    if (m) codes.add(m[1].toUpperCase());
  }
  const lead = /^([A-Za-z0-9#]{2,6})\s+(\S.*)$/.exec(base);
  if (lead && codes.has(lead[1].replace(/^#/, '').toUpperCase())) names.push(lead[2].trim());
  // The search runs on the narrowest spelling: the shortcode is a word Asana has to match
  // somewhere, and the task's own name is the text most likely to come back verbatim.
  return { query: names[names.length - 1], names };
}

// A subtask carries no projects of its own — Asana files the parent and hangs the subtask
// off it — so read literally, every subtask belongs nowhere and was invisible here. Its
// home is the parent's project, which the search now returns in the same call.
function taskProjects(t) {
  if (t && Array.isArray(t.projects) && t.projects.length) return t.projects;
  const p = t && t.parent;
  return (p && Array.isArray(p.projects)) ? p.projects : [];
}

// House task names are prefixed "✨ " and often a severity dot, and a name pasted out of
// the app carries them while a name typed from memory does not. That decoration is ours,
// not part of what the task is called, so it is stripped from both sides.
function sameTaskName(a, b) {
  const norm = (s) => String(s || '')
    .replace(/^[\s✨🔴🟠🟡🟢⚠️️]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return norm(a) === norm(b) && norm(a).length > 0;
}

// Only an EXACT name match counts. `asana find` is a fuzzy search — it answers a
// three-word query with twenty loosely-related tasks — so anything less than verbatim
// would be the guessing the model already does, at the cost of a network call.
function matchAsanaTask(names, list, targets) {
  const resolved = [];
  for (const t of list) {
    if (!names.some((n) => sameTaskName(t && t.name, n))) continue;
    const projects = taskProjects(t);
    const target = targets.find((x) => x.gid && projects.some((p) => p && p.gid === x.gid));
    if (target) resolved.push({ task: t, target });
  }
  if (!resolved.length) return null;
  // The same name under two different clients is not evidence of anything. Giving up
  // hands the decision back to the model, which is where it started.
  if (resolved.some((r) => r.target !== resolved[0].target)) return null;
  // A completed task means the subject came round again and wants a new one filed in
  // the same project — only an open task is something to comment on.
  const open = resolved.find((r) => !r.task.completed);
  return { target: resolved[0].target, task: open ? open.task : null };
}

// Runs alongside the routing call, not after it: ~0.9s, which is inside what the model
// spends anyway. Any failure resolves to null and the model's answer stands.
function findAsanaTask(question, targets) {
  return new Promise((resolve) => {
    const cmd = asanaCommand();
    const { query, names } = asanaTaskNames(question, targets);
    // A handful of characters would match half the workspace under a fuzzy search, and
    // an exact hit on them would be a coincidence rather than a reference.
    if (!cmd || query.length < 8) return resolve(null);
    const tokens = cmd.split(/\s+/);
    let child;
    try {
      child = cp.execFile(
        tokens[0], [...tokens.slice(1), 'find', query, '--limit', '20', '--json'],
        { timeout: 15000, maxBuffer: 1 << 22 },
        (err, stdout) => {
          if (err) return resolve(null);
          let list; try { list = JSON.parse(String(stdout || '')); } catch { return resolve(null); }
          resolve(Array.isArray(list) ? matchAsanaTask(names, list, targets) : null);
        }
      );
    } catch { return resolve(null); }
    child.on('error', () => resolve(null));
  });
}

// ── the routing table ────────────────────────────────────────────────────────

// The Asana projects that aren't a client's own, and where their work lives.
const HOUSE_PROJECTS = [
  { re: /^EEB EDV$/i, code: 'EEB', desc: 'our own business admin' },
  { re: /Hosting$/, code: 'EEB', sub: 'hosting', desc: 'our servers and hosting' },
  { re: /^infra$/i, repo: 'infra', desc: 'our own tooling, skills and this workstation' },
  { re: /AI Sandbox$/i, scratch: true, desc: 'throwaway tests of the Asana tooling' },
];

function asanaTasks() {
  return agentSessions().filter((e) => e && e.permalink);
}

// Session id first: it is exact. The working dir is the fallback for terminals we
// can't tie to an id (a window reload empties the id→terminal map) — safe because
// the bridge gives every task its own directory; newest entry wins if a dir was
// reused. Pass `entries` to resolve a whole tree render off one index read.
function asanaTaskFor(sessionId, dir, entries) {
  const list = entries || asanaTasks();
  if (sessionId) {
    const hit = list.find((e) => e.sessionId === sessionId);
    if (hit) return hit;
  }
  if (!dir) return null;
  const stamp = (e) => Date.parse(e.resumedAt || e.createdAt || '') || 0;
  return list.filter((e) => e.dir === dir).sort((a, b) => stamp(b) - stamp(a))[0] || null;
}

function openAsanaTask(entry) {
  if (!entry || !entry.permalink) {
    vscode.window.showInformationMessage('No Asana link recorded for this session.');
    return;
  }
  vscode.env.openExternal(vscode.Uri.parse(entry.permalink));
}

// ─── terminals ───────────────────────────────────────────────────────────────

module.exports = {
  asanaCommand, asanaCacheFile, parseAsanaProjects, loadAsanaProjects, refreshAsanaProjects,
  QUEUE_SCOPES, queueCountsFile, loadQueueCounts, refreshQueueCounts, asanaTaskQuery,
  asanaTaskNames, taskProjects, sameTaskName, matchAsanaTask, findAsanaTask, HOUSE_PROJECTS,
  asanaTasks, asanaTaskFor, openAsanaTask,
};
