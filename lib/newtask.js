const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const https = require('https');

const {
  HOUSE_PROJECTS, QUEUE_SCOPES, asanaAvailable, asanaTaskQuery, findAsanaTask, loadAsanaProjects, loadQueueCounts, refreshAsanaProjects, refreshQueueCounts,
} = require('./asana');
const { launchClaude } = require('./launch');
const { loadMailInbox, mailAvailable, mailCacheAge, mailEntry, mailInboxCommand, refreshMailInbox, triagePrompt } = require('./mail');
const { cfg, expandHome, listSessions, shortHome, timestampName } = require('./shared');
function titleModel() { return cfg().get('titleModel') || 'claude-haiku-4-5-20251001'; }

// Keep at most the first two hyphen-separated words of whatever the model echoed
// back, and make it filesystem-safe. Returns '' when nothing usable came out.
function sanitiseSlug(raw) {
  const line = String(raw || '').trim().split('\n').filter(Boolean).pop() || '';
  const words = line.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean);
  return words.slice(0, 2).join('-').slice(0, 40);
}

// ── the Asana project list ───────────────────────────────────────────────────
//
// What the box types most often isn't a coding question, it's "asana <subject>" or
// "email <subject>". For those the Asana project the item belongs to is what decides
// the folder, so the project list is part of the routing table, not an afterthought.
// `asana projects` takes ~0.8s, which is too much to pay on every submit, so the list
// is cached on disk and refreshed in the background.

// Where every queue button ends up: a new session in the home folder whose first
// prompt is the skill invocation. Named, so the tab says which queue it is walking
// instead of a timestamp.
function startQueueSession(prompt, label, icon) {
  return launchClaude({ path: os.homedir(), label }, false,
    { skipNamePrompt: true, initialPrompt: prompt, namePrefix: icon ? `${icon} ` : '' });
}

// ── the task we already have ─────────────────────────────────────────────────
//
// Half of what gets pasted into the box is the name of a task that already exists —
// an alert-spawned Asana task, a title copied out of the app. That name answers the
// routing question outright: the project it sits in IS the destination, and no amount
// of shortcode-and-company-name matching can beat it. "✨ 🔴 MP startpage publisher
// (moneyprofiler.de)" routed to nothing, because nothing in the table says SFF owns
// moneyprofiler.de — while five tasks by that exact name sat in SFF EDV.
//
// It also catches the duplicate: those five exist because every run created a task
// instead of commenting on the open one.

function clientsRoot() { return expandHome(cfg().get('clientsDir') || '~/clients'); }

function projectsRoot() { return expandHome(cfg().get('projectsDir') || '~/projects'); }

function dirsIn(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name);
  } catch { return []; }
}

// The directory for a client shortcode. A leading '#' is a quick-find marker, not part
// of the code, so both spellings are candidates — EEB has both, ~/clients/EEB holding
// its sessions and ~/clients/#EEB its long-running project folders. When a subfolder is
// named, the candidate that actually has it wins; otherwise the exact spelling does.
function clientDir(code, folders, sub) {
  const root = clientsRoot();
  const list = (folders || dirsIn(root)).filter((f) => f === code || f.replace(/^#/, '') === code);
  const candidates = list.sort((a, b) => (a === code ? -1 : b === code ? 1 : 0)).map((f) => path.join(root, f));
  if (sub) {
    const withSub = candidates.find((d) => fs.existsSync(path.join(d, sub)));
    if (withSub) return withSub;
  }
  return candidates[0] || null;
}

// `client_name` is what the IT Portal sync writes, but a hand-made agent.json spells it
// `name`, and one or two carry only `business`. Reading the one key left 12 of 68 clients
// described to the router as "client SFF" — a tautology in the one field that exists to
// make an opaque shortcode matchable.
function clientName(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '.agent', 'agent.json'), 'utf8'));
    return j.client_name || j.name || j.business || '';
  } catch { return ''; }
}

// The Asana project a client's work is filed in. Most are "<CODE> EDV", but plenty are
// not — SFC's only project is "SFC Websites", PCS's is a bare "PCS" — so a client is
// never keyed on that spelling; this only decides which project the task GETS FILED IN
// once the client is already known.
//
// Several projects can share a shortcode, so the primary one is preferred and a genuine
// tie gives up: "IR misc" and "IR magento" are both plausible and picking either is a
// guess that files work in the wrong place. Returning null is safe — the client is still
// a destination, and decoratePrompt then asks the session to choose the project.
function clientProject(code, projects) {
  const want = code.toUpperCase();
  // "WD - EDV" is the one irregular spelling; normalising it here keeps it a primary.
  const norm = (n) => n.toUpperCase().replace(/\s+-\s+/, ' ').trim();
  const cand = projects.filter((p) => !/\bold\b/i.test(p.name)
    && !HOUSE_PROJECTS.some((h) => h.re.test(p.name))
    && p.name.split(/\s+/)[0].toUpperCase() === want);
  return cand.find((p) => norm(p.name) === `${want} EDV`)
    || cand.find((p) => norm(p.name) === want)
    || (cand.length === 1 ? cand[0] : null);
}

// A repo can be an Asana project in its own right — ~/projects/healthboard and the
// project "Healthboard" are one thing under two names. Nothing recorded that link, so a
// repo target carried no gid, and the exact-task lookup only recognises a task whose
// project is one of the destinations: "Nährstoff Display" — a task sitting in Healthboard
// — matched nothing and was handed back to the model to route on wordplay.
//
// Only an exact name match counts, and a project already claimed by a client or house
// target is not up for grabs. A tie is dropped rather than guessed: filing work in the
// wrong project is worse than not finding it.
function repoProject(name, projects, used) {
  const want = name.trim().toLowerCase();
  const cand = projects.filter((p) => !used.has(p.gid)
    && !/\bold\b/i.test(p.name)
    && p.name.trim().toLowerCase() === want);
  return cand.length === 1 ? cand[0] : null;
}

// One flat list of everywhere an entry can go: every client, the house projects, and
// every local repo.
//
// Clients come from the ~/clients folders, NOT from the Asana project list. Keying them
// on a project named "<CODE> EDV" left 31 of 68 clients — SFC, PCS, PM, VS, IR, NANO …
// — with no destination at all, so the router could only answer "none" and their work
// landed in the scratch folder however clearly the entry named them. The folder is what
// a session actually needs, and it exists whether or not the project is spelled that way.
function listTargets() {
  const folders = dirsIn(clientsRoot());
  const projects = loadAsanaProjects();
  const out = [];
  for (const p of projects) {
    const house = HOUSE_PROJECTS.find((h) => h.re.test(p.name));
    if (!house || /\bold\b/i.test(p.name)) continue;
    let dir = null, create = true;
    if (house.repo) { dir = path.join(projectsRoot(), house.repo); create = false; }
    else if (!house.scratch) {
      const c = clientDir(house.code, folders, house.sub);
      if (!c) continue;
      dir = house.sub ? path.join(c, house.sub) : c;
    }
    out.push({ id: `asana:${p.gid}`, name: p.name, gid: p.gid, dir, create, desc: house.desc });
  }
  // A '#' prefix is a quick-find marker, not part of the code, so both spellings of a
  // client collapse onto the one directory clientDir() resolves.
  const houseCodes = new Set(HOUSE_PROJECTS.map((h) => h.code).filter(Boolean));
  for (const code of [...new Set(folders.map((f) => f.replace(/^#/, '')))].sort()) {
    if (houseCodes.has(code)) continue;   // EEB is already in as its house projects
    const dir = clientDir(code, folders);
    if (!dir || out.some((t) => t.dir === dir)) continue;
    const p = clientProject(code, projects);
    out.push({
      id: `client:${code}`,
      // The project name when there is one: it is what the model reads as the
      // destination, and what decoratePrompt quotes back to the session.
      name: p ? p.name : code,
      gid: p ? p.gid : '',
      dir,
      // A client folder is a home for many sessions, so each entry gets its own slug
      // subfolder under it — never the client root itself.
      create: true,
      // Shortcodes are opaque (BB, RAHR, 2W), so the company name goes to the model
      // too — matching on "BERGMANN" is far safer than on "BB".
      desc: clientName(dir) || `client ${code}`,
    });
  }
  const taken = new Set(out.map((t) => t.dir).filter(Boolean));
  const used = new Set(out.map((t) => t.gid).filter(Boolean));
  for (const name of dirsIn(projectsRoot())) {
    const dir = path.join(projectsRoot(), name);
    if (taken.has(dir)) continue;   // 'infra' is already in as its Asana project
    const p = repoProject(name, projects, used);
    if (p) used.add(p.gid);
    out.push({
      id: `repo:${name}`,
      name,
      gid: p ? p.gid : '',
      dir,
      create: false,
      desc: p ? `local dev project — its work is filed in Asana project "${p.name}"`
              : 'local dev project — session runs in the repo',
    });
  }
  return out;
}

function findTarget(id) {
  const want = String(id || '').trim().toLowerCase();
  if (!want || want === 'none') return null;
  return listTargets().find((t) => t.id.toLowerCase() === want) || null;
}

// The key for the routing calls, from the environment or, since the extension host
// doesn't inherit a login shell's env, from an env file. Never logged.
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const file = expandHome(cfg().get('apiKeyFile') || '~/.env');
    const m = fs.readFileSync(file, 'utf8').match(/^[ \t]*(?:export[ \t]+)?ANTHROPIC_API_KEY[ \t]*=[ \t]*(.+?)[ \t]*$/m);
    return m ? m[1].replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

// Routing is one small Haiku call. Through `claude -p` it took ~9s, almost all of it
// the CLI booting around a request the API answers in ~1.1s (both measured on the same
// prompt). So the API is the path, and the CLI stays as the fallback for when no key is
// configured or the request fails — it needs no key of its own.
async function askModel(prompt, system) {
  const key = apiKey();
  if (key) {
    const out = await askApi(prompt, key, system);
    if (out) return out;
  }
  return askModelCli(prompt, system);
}

function askApi(prompt, key, system) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: titleModel(),
      max_tokens: 200,
      // The CLI wraps these calls in a system prompt of its own; the API sends exactly
      // what it is given, and without one the model is markedly looser — the folder
      // matcher accepted a new-printer note as a continuation of a USB-copy folder.
      ...(system ? { system } : {}),
      // The API defaults to temperature 1, which the CLI does not. Left at the default
      // these calls get creative: the folder matcher started accepting a printer task
      // as a continuation of a USB-copy folder. Classification wants no creativity.
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    let req;
    try {
      req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 20000,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j && j.content && j.content[0] && j.content[0].text ? String(j.content[0].text) : '');
          } catch { resolve(''); }
        });
      });
    } catch { resolve(''); return; }
    req.on('error', () => resolve(''));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(''); });
    req.end(body);
  });
}

// ── the mail the entry points at ─────────────────────────────────────────────
//
// "email Cloudflare" is not a two-word subject, it is a pointer to a message sitting in
// the inbox — and everything that decides the destination (who sent it, which client
// they are) is in that message, not in the two words. Without dereferencing it the
// model is shown "Cloudflare" and a client list and routes it to nothing, correctly.
// The lookup reads the mailbox over IMAP (read-only) and maps the sender through
// client-emails.json, the same table that files a labelled mail into its project.
function mailLookupCommand() { return expandHome((cfg().get('mailLookupCommand') || '').trim()); }

function isMailEntry(q) { return /^email\s+\S/i.test(String(q || '').trim()); }

function findMail(question) {
  return new Promise((resolve) => {
    const cmd = mailLookupCommand();
    const subject = asanaTaskQuery(question);
    if (!cmd || !isMailEntry(question) || subject.length < 3) return resolve(null);
    const tokens = cmd.split(/\s+/);
    let child;
    try {
      child = cp.execFile(
        tokens[0], [...tokens.slice(1), subject],
        // Gmail's IMAP login + SELECT alone swings between 4 and 10s from here (measured
        // 2026-08-26); a timeout that sometimes drops the answer is worse than the wait.
        { timeout: 25000, maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err) return resolve(null);
          let m; try { m = JSON.parse(String(stdout || '')); } catch { return resolve(null); }
          resolve(m && m.subject ? m : null);
        }
      );
    } catch { return resolve(null); }
    child.on('error', () => resolve(null));
  });
}

// The client the mail's sender belongs to, as a routing target. A house code (EEB) has
// several projects and no single "client:" entry, so only real clients resolve here;
// the model still sees the sender and decides the rest.
function mailTarget(mail, targets) {
  const code = mail && mail.client ? String(mail.client).toUpperCase() : '';
  if (!code) return null;
  return targets.find((t) => t.id.toUpperCase() === `CLIENT:${code}`) || null;
}

function mailContext(mail) {
  if (!mail) return [];
  return [
    'The entry points at this mail in the inbox:',
    `From: ${mail.from}`,
    `Subject: ${mail.subject}`,
    `Date: ${mail.date}`,
    ...(mail.client ? [`Sender belongs to client: ${mail.client}`] : []),
    ...(mail.snippet ? [`Excerpt: ${mail.snippet}`] : []),
    '',
  ];
}

// cwd is a temp dir so the call doesn't drag in a project's CLAUDE.md, and MCP servers,
// hooks and tools stay unloaded — this classifies one line of text and has no use for
// any of them (worth ~2.5s of the CLI's boot, measured).
function askModelCli(prompt, system) {
  return new Promise((resolve) => {
    const tokens = (cfg().get('claudeCommand') || 'claude').trim().split(/\s+/);
    const text = system ? `${system}\n\n${prompt}` : prompt;
    let child;
    try {
      child = cp.execFile(
        tokens[0],
        [...tokens.slice(1), '-p', text, '--model', titleModel(), '--strict-mcp-config', '--settings', '{}'],
        { cwd: os.tmpdir(), timeout: 40000, maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err ? '' : String(stdout || ''))
      );
    } catch { resolve(''); return; }
    child.on('error', () => resolve(''));
    // `claude -p` reads stdin for piped input and waits on it; execFile leaves the
    // pipe open, so without this the call stalls until the timeout every time.
    try { child.stdin.end(); } catch {}
  });
}

// What the entry is, where it belongs and a two-word folder name in one round trip, then
// whether it continues work that already has a folder. Degrades to a bare scratch plan
// on any failure or timeout.
// `known` is a mail the ✉️ picker already has in hand. Everything below is the same
// either way — only the ~6s IMAP round trip that finds it is skipped.
async function generateSessionPlan(question, known) {
  refreshAsanaProjects(12);
  const targets = listTargets();
  const routeSystem = 'You route a short work note to one destination from a fixed list. '
    + 'You reply with exactly one JSON object and nothing else. Ids are copied character-for-character '
    + 'from the list you were given; you never invent one, and you answer "none" rather than guess.';
  // The mail comes first, not alongside: its sender is what the routing call needs to
  // see, so for an "email" entry the ~1s IMAP round trip is on the critical path.
  const mail = known || await findMail(question);
  const [routed, hit] = await Promise.all([
    askModel(routingPrompt(question, targets, mail), routeSystem),
    findAsanaTask(question, targets),
  ]);
  const plan = parseSessionPlan(routed, targets);
  // An entry that names a task we hold is not a classification problem — the project
  // it is filed in is the answer, so it outranks whatever the model decided.
  if (hit) { plan.target = hit.target; plan.task = hit.task; }
  // Likewise a mail whose sender is a known client: the registry says where it goes.
  if (mail) {
    plan.kind = 'email';
    plan.mail = mail;
    const t = mailTarget(mail, targets);
    if (t) plan.target = t;
  }
  plan.slug = plan.slug || timestampName();
  plan.existing = await findExistingFolder(question, plan);
  return plan;
}

function routingPrompt(question, targets, mail) {
  {
    // Clients get a line each — the company name is what makes an opaque shortcode
    // matchable. Repos are just names, on one line: spelling out "local dev project"
    // 58 times cost more latency than it ever bought in accuracy.
    const homes = targets.filter((t) => !t.id.startsWith('repo:'));
    const repos = targets.filter((t) => t.id.startsWith('repo:'));
    const prompt = [
      'Route one entry from a "New Task" box.',
      '',
      'Entry:', question, '',
      ...mailContext(mail),
      'Clients and house projects — "<id> — <Asana project> — <client or subject>":',
      ...homes.map((t) => `${t.id} — ${t.name} — ${t.desc}`),
      '',
      'Local dev repos, id is "repo:<name>":',
      repos.map((t) => t.name).join(', '),
      '',
      'Reply with ONLY a JSON object, no prose, no code fence:',
      '{"kind":"asana"|"email"|"session","target":"<id>"|"none","slug":"<two words>"}',
      '',
      'Rules:',
      '- kind "asana": something to be filed as a task or remembered — a to-do, a reminder,',
      '  a note to follow up. Often written as "asana <subject>".',
      '- kind "email": a mail to be written to somebody. Often written as "email <subject>",',
      '  or names a recipient ("an Herrn Wagner", "reply to ...", an address).',
      '- kind "session": actual work to do right now — a question, a bug, a change to make.',
      '- target must be an id from the lists above, copied verbatim, or "none".',
      '- An "asana" or "email" entry belongs to the client or house target whose client or',
      '  subject it is about — that decides the Asana project it will be filed in.',
      '- A "session" entry belongs to a repo: target when it names one, otherwise to the',
      '  client: target for the client it is about. A client is a valid destination even',
      '  when its own shortcode is all the entry says about it.',
      '- Shortcodes that merely look alike (RAH vs RAHR, PR vs PRX) are unrelated clients.',
      '  Never guess from a resemblance — prefer "none".',
      '- slug: exactly two lowercase words joined by a hyphen, summarising the entry.',
    ].join('\n');
    return prompt;
  }
}

// The head of a file, not the file: a HANDOFF.md runs to tens of kilobytes and there are
// up to 60 folders to look at. Everything read here — the title line, the gid on line 5 —
// is in the first few hundred bytes.
function fileHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} }
}

// What the folder is ABOUT, in the words the work itself used. Folder names are two-word
// slugs, and matching an entry against a bare slug is matching wordplay: "rah 4. Final
// Local Folders copy" was read as a continuation of "rah-destination-side" — a backup
// freshness check — because "copy" and "destination" sit near each other and nothing in
// the prompt said what that folder held.
function folderSubject(dir) {
  for (const f of ['TASK.md', 'HANDOFF.md', 'README.md']) {
    const line = (fileHead(path.join(dir, f)).split('\n').find((l) => l.trim()) || '').trim();
    if (!line) continue;
    return line
      .replace(/^#+\s*/, '')
      .replace(/^HANDOFF\s*[—–-]\s*/i, '')
      .replace(/^[\s✨🔴🟠🟡🟢⚠️]+/u, '')
      .trim()
      .slice(0, 90);
  }
  return '';
}

// The Asana task a folder belongs to, when it belongs to one: the bridge writes the gid
// into its marker file, and a task directory carries it in TASK.md. This is evidence, not
// a resemblance — the folder for a task is the one that says so.
function folderTaskGid(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '.asana-claude.json'), 'utf8'));
    if (j && j.taskGid) return String(j.taskGid);
  } catch {}
  const m = fileHead(path.join(dir, 'TASK.md')).match(/Task GID:\**\s*`?(\d{6,})/i);
  return m ? m[1] : '';
}

// Coming back to a task or a mail should land in the folder it already has, not beside
// it. Past entries left their slug as a folder name under the same target, so this is a
// name-matching question — one more ~1s call on top of the routing. Only targets that
// hold one folder per piece of work are searched; a repo target IS the working directory.
//
// Two things are NOT a judgement call here. A folder that already carries an Asana gid is
// the home of that one task: it is reachable by naming that task and no other way, because
// a session resumed there inherits the bridge's ASANA_TASK_GID and posts its comments onto
// whatever task the folder belongs to. And when the entry itself resolved to a task, the
// gid decides — matching by gid or starting fresh, never asking the model to guess.
async function findExistingFolder(question, plan) {
  const root = plan.target
    ? (plan.target.create ? plan.target.dir : null)
    : expandHome(cfg().get('scratchDir') || '~/tasks');
  if (!root) return null;
  const folders = dirsIn(root)
    .map((name) => {
      const dir = path.join(root, name);
      let mtime = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch {}
      return { name, dir, mtime, gid: folderTaskGid(dir) };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 60);
  if (!folders.length) return null;
  // The entry named a task we hold, so there is nothing to weigh: its folder is the one
  // stamped with its gid. No stamp means this task has no folder yet — a new one, not the
  // nearest-looking neighbour.
  const wanted = plan.task && plan.task.gid ? String(plan.task.gid) : '';
  if (wanted) {
    const hit = folders.find((f) => f.gid === wanted);
    return hit ? hit.dir : null;
  }
  // A folder a task already owns is not a destination for an entry we could not tie to
  // that task — a session resumed there inherits its gid. It stays in the list shown to
  // the model, though: hiding the folder an entry genuinely belongs to only pushes the
  // answer onto the next-nearest lookalike, and "the right folder, not reusable" has to
  // come out as a fresh folder rather than as somebody else's.
  //
  // The slug is generated from the entry, so the same subject twice often names the
  // same folder — worth checking for free before asking.
  const exact = folders.find((f) => !f.gid && f.name === plan.slug);
  if (exact) return exact.dir;
  // Worked examples do the heavy lifting here: "same client, different subject" is the
  // mistake this call makes, and stating the rule abstractly was not enough to stop it.
  const system = [
    'You match a short work note against a list of existing folders.',
    'Each line is a folder name, and where the work recorded one, " — " and its subject.',
    'You reply with exactly one line and nothing else: either a folder name copied',
    'character-for-character from the list, or the single word none.',
    'You are strict. A folder is only a match when it is about the SAME specific thing the',
    'note is about — the same machine, ticket, document, person or fault. Sharing a',
    'client, a technology or a general area is not a match. When in any doubt: none.',
  ].join(' ');
  const prompt = [
    'Work note:', question, '',
    'Existing folders:',
    ...folders.map((f) => {
      const subject = folderSubject(f.dir);
      return subject ? `${f.name} — ${subject}` : f.name;
    }),
    '',
    'Examples of the judgement:',
    '- note "the VPN keeps dropping at DRM", folder "vpn-restart-problem" → vpn-restart-problem (same fault)',
    '- note "DRM needs a new Exchange connector", folder "DRM-webserverinstall" → none (both DRM, different subject)',
    '- note "set up the new printer", folder "rahr-usb-copy" → none (both hardware, different device)',
    '',
    'Which folder is this note a continuation of? Reply with the folder name, or none.',
  ].join('\n');
  const answer = (await askModel(prompt, system)).trim().split('\n').filter(Boolean).pop() || '';
  const want = answer.trim().replace(/^[`'"]+|[`'".]+$/g, '').toLowerCase();
  if (!want || want === 'none') return null;
  const hit = folders.find((f) => f.name.toLowerCase() === want);
  return hit && !hit.gid ? hit.dir : null;
}

// A target only counts if it matches one we actually offered — a model that invents or
// misremembers a shortcode must degrade to the scratch folder, never write into some
// other client's directory.
function parseSessionPlan(stdout, targets) {
  const out = { slug: '', kind: 'session', target: null, task: null };
  const m = String(stdout || '').match(/\{[\s\S]*\}/);
  if (!m) return out;
  let obj; try { obj = JSON.parse(m[0]); } catch { return out; }
  out.slug = sanitiseSlug(obj.slug);
  const kind = String(obj.kind || '').trim().toLowerCase();
  if (kind === 'asana' || kind === 'email') out.kind = kind;
  // The id as asked for, but also the shapes the model reaches for on its own: a bare
  // gid, or a bare repo/project name. Anything that doesn't resolve to a target we
  // actually offered degrades to the scratch folder — a misremembered shortcode must
  // never write into some other client's directory.
  const want = String(obj.target || '').trim().toLowerCase();
  out.target = want && want !== 'none'
    ? targets.find((t) => t.id.toLowerCase() === want)
      || targets.find((t) => t.gid === want)
      || targets.find((t) => t.name.toLowerCase() === want.replace(/^(asana|repo|project|client):/, ''))
      || null
    : null;
  return out;
}

function uniqueDir(dir) {
  if (!fs.existsSync(dir)) return dir;
  const parent = path.dirname(dir), base = path.basename(dir);
  let i = 2, cand;
  do { cand = path.join(parent, `${base}-${i++}`); } while (fs.existsSync(cand));
  return cand;
}

const KIND_LABEL = { asana: 'Asana task', email: 'Email', session: 'Session' };

// Turn the raw entry into the session's first prompt. A "session" entry is passed
// through untouched — it already says what it wants. The other two are the typing the
// box exists to save: the verb and the destination are stated here instead.
function decoratePrompt(q, kind, target, task, mail) {
  if (kind === 'asana') {
    // The search the cold instruction below asks for has already been done, by name and
    // exactly: this IS that task. Saying so is what stops the sixth copy of it.
    if (task) {
      return [
        `Comment on the existing Asana task "${task.name}" (${task.gid}) — do NOT create a second one.`,
        ...(task.permalink_url ? [task.permalink_url] : []),
        'Follow the comment conventions in CLAUDE.md and refresh the Status line with `asana status`.',
        '', 'Note:', q,
      ].join('\n');
    }
    const where = target && target.gid ? `Asana project "${target.name}" (${target.gid})` : 'the right Asana project';
    return [
      `Create an Asana task in ${where}, following the conventions in CLAUDE.md.`,
      'Search that project for an existing task on this first — if there is one, comment there instead.',
      'Report the task link when done.',
      '', 'Task:', q,
    ].join('\n');
  }
  if (kind === 'email') {
    const about = target ? ` It concerns ${target.desc || target.name}.` : '';
    if (mail) {
      return [
        `Reply to this mail with the email-writing skill, then show the draft and wait for approval — nothing is sent unprompted.${about}`,
        'Read the full thread first (Gmail MCP, or the link below) and answer what it actually asks.',
        `From: ${mail.from}`,
        `Subject: ${mail.subject}`,
        `Date: ${mail.date}`,
        ...(mail.thread_link ? [mail.thread_link] : []),
        '', 'Note:', q,
      ].join('\n');
    }
    return [
      `Draft this email with the email-writing skill, then show it and wait for approval — nothing is sent unprompted.${about}`,
      '', 'Mail:', q,
    ].join('\n');
  }
  // A "session" entry says what it wants and is passed through — but when the entry is
  // the NAME of a task we hold, the session is working that task and should say so in the
  // right place rather than opening a second one for the same thing.
  if (task) {
    return [
      `This is Asana task "${task.name}" (${task.gid}) — work it there; do NOT create a second one.`,
      ...(task.permalink_url ? [task.permalink_url] : []),
      '', q,
    ].join('\n');
  }
  return q;
}

function scratchTarget(slug) {
  return { id: 'none', name: 'Scratch', dir: path.join(expandHome(cfg().get('scratchDir') || '~/tasks'), slug), create: true, desc: 'unscoped scratch folder' };
}

// Where the session actually runs. A client or house target is a home for many
// sessions, so each entry gets its own slug subfolder; a repo target IS the workspace.
function targetDir(target, slug) {
  if (!target || !target.dir) return scratchTarget(slug).dir;
  return target.create ? path.join(target.dir, slug) : target.dir;
}

// Start a session whose first prompt is the user's entry, in the folder the Asana
// project (or repo) it was routed to implies. The proposal is shown in the box itself
// and confirmed there: shortcodes are easy to confuse and a wrong guess would write
// into another client's directory, so a match is never assumed.
async function askClaudeSession(question, io, known) {
  const q = String(question || '').trim();
  if (!q) return;
  // refocus: put the cursor back in the box on the way to idle. Right after a
  // cancellation that is what the user wants; right after a launch it would steal
  // focus from the terminal the session just opened in.
  const state = (s, refocus) => { try { io && io.state && io.state(s, refocus); } catch {} };
  state('naming');
  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Claude: routing task…' },
    () => generateSessionPlan(q, known)
  );
  const slug = plan.slug || timestampName();
  let kind = plan.kind;
  let target = plan.target || scratchTarget(slug);
  let existing = plan.existing;
  let task = plan.task || null;
  const mail = plan.mail || null;

  for (;;) {
    const reply = await io.propose({
      kind,
      kindLabel: KIND_LABEL[kind],
      target: task ? `${target.name} — existing task`
        : (mail && mail.from_address ? `${target.name} — mail from ${mail.from_address}` : target.name),
      dir: shortHome(existing || targetDir(target, slug)),
      existing: !!existing,
    });
    if (!reply || reply.type === 'cancel') { state('idle', true); return; }
    // Tab cycles the intent in the box, so any reply can carry a changed one — including
    // the one that only asks for the folder picker.
    if (reply.kind && KIND_LABEL[reply.kind]) kind = reply.kind;
    if (reply.type !== 'pickTarget') break;
    // Reaching for the picker is how you say "not that folder", so a proposed
    // continuation is dropped: pick the same target again and you get a fresh one.
    // The task found by name belongs to the target that was just rejected, so it goes
    // with it — commenting on it from another client's folder would be worse than not
    // having found it.
    existing = null;
    task = null;
    const picked = await pickTarget(slug);
    if (picked) target = picked;
  }

  const create = !existing && target.create;
  const dir = existing || (create ? uniqueDir(targetDir(target, slug)) : target.dir);
  // `create` invents a slug subfolder inside a home for many sessions; `ensure` is
  // the picker's typed path, which is already the exact folder and only has to exist.
  if (create || (!existing && target.ensure && !fs.existsSync(dir))) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      state('idle', true);
      vscode.window.showErrorMessage(`Claude Code Helper: could not create ${dir} — ${e.message}`);
      return;
    }
  }
  // Continuing into a folder that already holds a session resumes it rather than
  // starting a second one beside it — and a resumed session already knows what it is
  // working on, so it gets the entry as typed, without the framing a cold start needs.
  const resume = !!existing && listSessions(dir).length > 0;
  state('launching');
  let started = false;
  try {
    started = !!(await launchClaude(
      { path: dir, label: path.basename(dir) }, resume,
      {
        skipNamePrompt: true,
        initialPrompt: resume ? q : decoratePrompt(q, kind, target, task, mail),
        // The folder is named after the subject, which reads like any other session; the
        // envelope is what says at a glance that this tab is holding a reply to a mail.
        namePrefix: mail ? '✉️ ' : '',
      }
    ));
  } finally {
    state('idle', !started);
  }
}

// Everywhere a session can go as a plain folder: first-level ~/projects, and first-
// AND second-level ~/clients. The Asana table only names places that have a project,
// so a client's one-off subfolder (~/clients/BF/router-swap) is reachable no other
// way. These run the session IN the folder — no slug subfolder is invented, because
// picking an exact folder is the point.
function listFolderTargets() {
  const out = [];
  const proj = projectsRoot();
  for (const name of dirsIn(proj)) {
    out.push({ id: `repo:${name}`, name, dir: path.join(proj, name), create: false, desc: 'local dev project', group: 'Projects' });
  }
  const root = clientsRoot();
  for (const code of dirsIn(root)) {
    const dir = path.join(root, code);
    const desc = clientName(dir) || `client ${code.replace(/^#/, '')}`;
    out.push({ id: `dir:${dir}`, name: code, dir, create: false, desc, group: 'Client folders' });
    for (const sub of dirsIn(dir)) {
      const sd = path.join(dir, sub);
      out.push({ id: `dir:${sd}`, name: `${code} / ${sub}`, dir: sd, create: false, desc, group: 'Client folders' });
    }
  }
  return out;
}

// What a typed path means. It is read against the same roots the list is built from,
// so "BF/router-swap" and "claude-code-helper/spike" both land where you would guess;
// a first segment that matches no client and no project falls through to scratch,
// which is also where a bare word ends up. Returns null for nonsense (a '..' escape).
function resolveTypedDir(text) {
  const raw = String(text || '').trim().replace(/[\\/]+$/, '');
  if (!raw) return null;
  if (raw.startsWith('~/') || path.isAbsolute(raw)) return expandHome(raw);
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..')) return null;
  const [head, ...rest] = parts;
  const tail = rest.join(path.sep);
  if (head === 'clients') return rest.length ? path.join(clientsRoot(), tail) : null;
  if (head === 'projects') return rest.length ? path.join(projectsRoot(), tail) : null;
  const c = clientDir(head, null, rest[0]);
  if (c) return tail ? path.join(c, tail) : c;
  const p = path.join(projectsRoot(), head);
  if (fs.existsSync(p)) return tail ? path.join(p, tail) : p;
  return path.join(expandHome(cfg().get('scratchDir') || '~/tasks'), parts.join(path.sep));
}

// The override behind Shift+Tab: scratch, then the client/house routing table, then every
// project and client subfolder — and, live as you type, an offer to create whatever
// path you are typing if it does not exist yet.
async function pickTarget(slug) {
  const scratch = scratchTarget(slug);
  const homes = listTargets().filter((t) => !String(t.id).startsWith('repo:'));
  const taken = new Set(homes.map((t) => t.dir).filter(Boolean));
  const folders = listFolderTargets().filter((t) => !taken.has(t.dir));
  const toItem = (t) => ({
    label: `$(folder) ${t.name}`,
    description: shortHome(targetDir(t, slug)),
    detail: t.desc,
    target: t,
  });
  const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const items = [toItem(scratch)];
  if (homes.length) items.push(sep('Clients & house projects'), ...homes.map(toItem));
  for (const group of ['Projects', 'Client folders']) {
    const inGroup = folders.filter((t) => t.group === group);
    if (inGroup.length) items.push(sep(group), ...inGroup.map(toItem));
  }

  const qp = vscode.window.createQuickPick();
  qp.placeholder = 'Where does this belong? — or type a new path (BF/router-swap) to create it';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = items;
  // Rebuilt only when the offer itself changes: reassigning items resets the
  // highlighted row, which on every keystroke would fight the typing.
  let offered = null;
  const render = () => {
    const dir = resolveTypedDir(qp.value);
    const create = dir && !fs.existsSync(dir) ? dir : null;
    if (create === offered) return;
    offered = create;
    qp.items = create ? [{
      label: `$(new-folder) Create ${shortHome(create)}`,
      detail: 'new folder — the session starts in it',
      alwaysShow: true,
      target: { id: `new:${create}`, name: path.basename(create), dir: create, create: false, ensure: true, desc: 'new folder' },
    }, ...items] : items;
  };
  qp.onDidChangeValue(render);
  return new Promise((resolve) => {
    let picked;
    qp.onDidAccept(() => { picked = qp.selectedItems[0]; qp.hide(); });
    qp.onDidHide(() => { qp.dispose(); resolve(picked ? picked.target : null); });
    qp.show();
  });
}

// A webview view is the only way to get a real, always-visible text field in the
// sidebar — tree views can't host input. Enter starts a scratch session with the
// typed text as the first prompt; Shift+Enter adds a newline.
class AskViewProvider {
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this._html(view.webview);
    // Counts: paint whatever the cache holds immediately, then refresh behind it.
    // Repeated on every re-show, because a count Pat read an hour ago is the one
    // thing that would make the buttons lie.
    // The mail number is the length of the cached list, not a separate count call —
    // so the button and the picker it opens can never disagree about how many there are.
    const pushCounts = () => {
      const counts = loadQueueCounts();
      // Only when there IS a cached list: an absent one is "not read yet", and painting
      // it as 0 is the wrong number the dash exists to avoid — three mails sat behind a
      // button reading 0 for the ten seconds the first read took.
      if (mailAvailable() && mailCacheAge() < Infinity) counts.mail = String(loadMailInbox().length);
      try { view.webview.postMessage({ type: 'counts', counts }); } catch {}
    };
    const freshenCounts = () => {
      pushCounts();
      refreshQueueCounts(2 * 60e3, pushCounts);
      refreshMailInbox(2 * 60e3, pushCounts);
    };
    freshenCounts();

    // Visibility alone is not enough to keep the numbers honest. The view is created
    // with retainContextWhenHidden, so a sidebar left open on this container never
    // fires onDidChangeVisibility again and the counts stay at whatever the cache
    // held when the window loaded — hours old, on a box that stays open all day.
    // So: tick while the view is actually visible, and stop when it is not.
    let tick = null;
    const startTicking = () => { if (!tick) tick = setInterval(freshenCounts, 60e3); };
    const stopTicking = () => { if (tick) { clearInterval(tick); tick = null; } };
    if (view.visible) startTicking();
    view.onDidChangeVisibility(() => { if (view.visible) { freshenCounts(); startTicking(); } else stopTicking(); });
    view.onDidDispose(() => stopTicking());
    view.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      const post = (m) => { try { view.webview.postMessage(m); } catch {} };
      if (msg.type === 'queue') {
        this._startQueue(msg.scope, post);
        return;
      }
      if (msg.type === 'mail') {
        this._startMail(post);
        return;
      }
      if (msg.type === 'ask') {
        askClaudeSession(msg.text, this._io(post));
        return;
      }
      if (this._answer && (msg.type === 'confirm' || msg.type === 'cancel' || msg.type === 'pickTarget')) {
        const answer = this._answer;
        this._answer = null;
        answer(msg);
      }
    });
  }
  // How a routed entry talks back to the box: the progress states, and the proposal,
  // which is a question — it resolves when the user accepts it, changes the intent,
  // asks for the folder picker, or cancels.
  _io(post) {
    return {
      state: (s, refocus) => post({ type: 'state', state: s, refocus: !!refocus }),
      propose: (p) => new Promise((resolve) => { this._answer = resolve; post({ type: 'propose', ...p }); }),
    };
  }

  // The ✉️ button. One mail goes through the same routing as a typed entry — the
  // picker just spares you retyping its subject, and hands the router the message it
  // would otherwise have gone to Gmail for. "All of them" is a different job: nothing
  // to route, so it starts one session that reads the lot and proposes a plan.
  async _startMail(post) {
    if (!mailAvailable()) {
      vscode.window.showWarningMessage('No inbox lookup configured — check the claudeHelper.mailInboxCommand setting.');
      return;
    }
    // A list read minutes ago still names the same mail; older than that and the
    // picker would be offering messages that have since been dealt with.
    let list = mailCacheAge() < 2 * 60e3 ? loadMailInbox() : null;
    if (!list) {
      list = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Claude: reading the inbox…' },
        () => new Promise((resolve) => refreshMailInbox(0, resolve))
      ).catch(() => null) || loadMailInbox();
    }
    if (!list.length) {
      vscode.window.showInformationMessage('Nothing in the inbox addressed to @erler-edv-beratung.de.');
      return;
    }
    const items = [
      {
        label: `$(inbox) Triage all ${list.length} messages`,
        detail: 'one session reads them all and proposes an action per mail',
        all: true,
      },
      { label: 'One mail', kind: vscode.QuickPickItemKind.Separator },
      ...list.map((m) => ({
        // The dot is the only thing marking an unread mail: a second column of
        // "unread"/"read" would push the subject off the row it has to be readable on.
        label: `${m.unread ? '$(circle-filled)' : '$(mail)'} ${m.subject || '(no subject)'}`,
        description: m.from || m.from_address || '',
        detail: [m.client ? `client ${m.client}` : null, m.date].filter(Boolean).join(' · '),
        mail: m,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Which mail? — or start one session over all of them',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) return;
    if (pick.all) {
      post({ type: 'state', state: 'launching' });
      let started = false;
      try {
        started = await launchClaude(
          { path: os.homedir(), label: 'mail triage' }, false,
          { skipNamePrompt: true, initialPrompt: triagePrompt(mailInboxCommand()), namePrefix: '✉️ ' }
        );
      } catch {}
      post({ type: 'state', state: 'idle', refocus: !started });
      return;
    }
    askClaudeSession(mailEntry(pick.mail), this._io(post), pick.mail);
  }

  // A queue button skips the whole routing machinery — the destination is known, so
  // there is nothing to propose and nothing to confirm. Only the project scope asks
  // anything, and what it asks is which project.
  async _startQueue(scope, post) {
    let prompt, label, icon;
    if (scope === 'project') {
      const projects = loadAsanaProjects();
      if (!projects.length) {
        vscode.window.showWarningMessage('No Asana project list cached yet — check the claudeHelper.asanaCommand setting.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        projects.map((p) => ({ label: p.name, gid: p.gid })),
        { placeHolder: 'Which project should the walkthrough cover?' }
      );
      if (!pick) return;
      prompt = `/inbox-zero project ${pick.gid}`;
      label = `inbox-zero · ${pick.label}`;
      icon = '📁';
    } else {
      const s = QUEUE_SCOPES.find((x) => x.id === scope);
      if (!s) return;
      prompt = s.prompt;
      label = `inbox-zero · ${s.label}`;
      icon = s.icon;
    }
    post({ type: 'state', state: 'launching' });
    let started = false;
    try { started = await startQueueSession(prompt, label, icon); } catch {}
    // Same contract as the text path: refocus only when nothing launched, so a
    // started session keeps the cursor Pat is about to type into.
    post({ type: 'state', state: 'idle', refocus: !started });
  }

  // The title-bar refresh button. Skips the 2-minute cache window deliberately:
  // pressing refresh means the cached number is the one you do not believe.
  refreshCounts() {
    const view = this.view;
    if (!view) return;
    refreshQueueCounts(0, () => {
      try { view.webview.postMessage({ type: 'counts', counts: loadQueueCounts() }); } catch {}
    });
  }

  // Show or hide the queue row without rebuilding the webview, for when the Asana
  // CLI appears or disappears under a running window.
  postAsanaState() {
    try { this.view.webview.postMessage({ type: 'asana', available: asanaAvailable(), mail: mailAvailable() }); } catch {}
  }

  _html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 6px 8px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  textarea {
    width: 100%; box-sizing: border-box; resize: none; min-height: 46px; max-height: 140px;
    padding: 4px 6px; font-family: inherit; font-size: inherit; line-height: 1.4;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  textarea:disabled { opacity: .6; }
  textarea[readonly] { opacity: .8; }
  #hint { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; min-height: 15px; }
  /* The routing proposal: intent and destination on one line, so accepting it is a
     glance and an Enter rather than a dialog. */
  #plan { margin-top: 4px; font-size: 11px; display: none; }
  #plan.on { display: block; }
  #kind { color: var(--vscode-textLink-foreground); font-weight: 600; }
  #dest { color: var(--vscode-foreground); }
  #dir { color: var(--vscode-descriptionForeground); word-break: break-all; }
  /* Indeterminate bar, VS Code's own: a slice sliding across a dim track. Naming
     takes ~10s, so the wait needs to look like progress, not like a hang. */
  /* The buttons occupy space the view cannot reclaim anyway: a sidebar webview keeps
     its allotted height, so everything under the hint is blank without them. */
  /* One row, always. Wrapping to a second row is what pushes this view past the
     height it is given and puts a scrollbar in a box that had spare space. */
  #queues { display: flex; flex-wrap: nowrap; gap: 3px; margin-top: 6px; }
  #queues button {
    flex: 1 1 auto; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    padding: 3px 6px; font-family: inherit; font-size: 11px; cursor: pointer; white-space: nowrap;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    border: none; border-radius: 2px;
  }
  #queues button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  #queues button:disabled { opacity: .5; cursor: default; }
  /* display:inline-flex above beats the UA's [hidden] rule, so a button that is not
     available here has to be hidden explicitly. */
  #queues button[hidden] { display: none; }
  #queues[hidden] { display: none; }
  /* Tabular figures so a count changing 9 -> 10 doesn't shuffle the row. */
  #queues .n { opacity: .75; font-variant-numeric: tabular-nums; }
  #bar { height: 2px; margin-top: 4px; overflow: hidden; display: none; }
  #bar.on { display: block; }
  #bar > div { width: 40%; height: 100%; background: var(--vscode-progressBar-background); animation: slide 2s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
</style></head><body>
<textarea id="q" rows="2" placeholder="Ask Claude…"></textarea>
<div id="bar"><div></div></div>
<div id="plan">→ <span id="kind"></span> · <span id="dest"></span><br><span id="dir"></span></div>
<div id="hint">Enter to start a session · Shift+Enter for a new line</div>
<div id="queues"${asanaAvailable() || mailAvailable() ? '' : ' hidden'}>
  <button data-scope="today" class="asana" title="Walk everything due today or overdue"${asanaAvailable() ? '' : ' hidden'}>📅 Today <span class="n" id="n-today">–</span></button>
  <button data-scope="input" class="asana" title="Walk the ⏳ Input needed queue"${asanaAvailable() ? '' : ' hidden'}>⏳ Input <span class="n" id="n-input">–</span></button>
  <button data-scope="today+input" class="asana" title="Walk Today and ⏳ Input as ONE queue — a task in both is walked once"${asanaAvailable() ? '' : ' hidden'}>📥 Both <span class="n" id="n-today+input">–</span></button>
  <button data-mail="1" title="Inbox mail to @erler-edv-beratung.de — one of them, or all of them"${mailAvailable() ? '' : ' hidden'}>✉️ Mail <span class="n" id="n-mail">–</span></button>
  <button data-scope="project" class="asana" title="Walk one project — pick which"${asanaAvailable() ? '' : ' hidden'}>📁</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const hint = document.getElementById('hint');
  const bar = document.getElementById('bar');
  const plan = document.getElementById('plan');
  const kindEl = document.getElementById('kind');
  const destEl = document.getElementById('dest');
  const dirEl = document.getElementById('dir');
  const IDLE = 'Enter to start a session · Shift+Enter for a new line';
  const CONFIRM = 'Enter start · Tab intent · Shift+Tab folder · Esc cancel';
  const CONTINUE = 'Enter continue · Tab intent · Shift+Tab new folder · Esc cancel';
  const KINDS = ['asana', 'email', 'session'];
  const KIND_LABEL = { asana: 'Asana task', email: 'Email', session: 'Session' };
  // Non-null exactly while a routing proposal is on screen; it is also the intent
  // that will be sent back, so Tab can cycle it without another round trip.
  let planKind = null;
  const clearPlan = () => { planKind = null; plan.classList.remove('on'); q.readOnly = false; };
  const answer = (msg) => { clearPlan(); vscode.postMessage(msg); };
  let tick = null, t0 = 0, label = '';
  const stopTick = () => { if (tick) { clearInterval(tick); tick = null; } };
  // Elapsed seconds alongside the bar — a concrete number reads as "still working"
  // far better than a spinner alone once the wait passes a few seconds.
  const startTick = (text) => {
    label = text;
    if (!tick) { t0 = Date.now(); tick = setInterval(paint, 1000); }
    paint();
  };
  const paint = () => { hint.textContent = label + ' ' + Math.round((Date.now() - t0) / 1000) + 's'; };
  const queues = document.getElementById('queues');
  const qBtns = queues.querySelectorAll('button');
  // A click is the whole gesture — no text, no proposal, no confirmation round.
  queues.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    vscode.postMessage(b.dataset.mail ? { type: 'mail' } : { type: 'queue', scope: b.dataset.scope });
  });
  const setQueuesBusy = (busy) => { for (const b of qBtns) b.disabled = busy; };
  const grow = () => { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 140) + 'px'; };
  q.addEventListener('input', grow);
  q.addEventListener('keydown', (e) => {
    if (planKind) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); answer({ type: 'confirm', kind: planKind }); }
      else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        planKind = KINDS[(KINDS.indexOf(planKind) + 1) % KINDS.length];
        kindEl.textContent = KIND_LABEL[planKind];
      }
      else if (e.key === 'Tab') { e.preventDefault(); answer({ type: 'pickTarget', kind: planKind }); }
      else if (e.key === 'Escape') { e.preventDefault(); answer({ type: 'cancel' }); }
      return;
    }
    // Escape with no proposal on screen throws the draft away. It reads as the
    // second Escape: the first one dismisses a proposal and deliberately leaves
    // the text alone, so pressing it again is how you say "and drop this too"
    // when a different opening turns out to be the better one.
    if (e.key === 'Escape') {
      if (!q.value) return;
      e.preventDefault();
      q.value = '';
      grow();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'ask', text });
  });
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'asana') {
      queues.hidden = !m.available && !m.mail;
      for (const b of qBtns) b.hidden = b.dataset.mail ? !m.mail : !m.available;
      return;
    }
    if (m.type === 'counts') {
      // A scope missing from the payload keeps its dash: no number beats a wrong one.
      for (const s of ['today', 'input', 'today+input', 'mail']) {
        const el = document.getElementById('n-' + s);
        if (el) el.textContent = (m.counts && m.counts[s]) || '–';
      }
      return;
    }
    if (m.type === 'propose') {
      setQueuesBusy(true);
      stopTick();
      bar.classList.remove('on');
      planKind = m.kind;
      kindEl.textContent = m.kindLabel;
      destEl.textContent = m.target;
      dirEl.textContent = (m.existing ? 'continue in ' : '') + m.dir;
      plan.classList.add('on');
      hint.textContent = m.existing ? CONTINUE : CONFIRM;
      // Readonly rather than disabled: a disabled textarea can't take focus, and the
      // proposal is answered with keys typed at this box.
      q.disabled = false;
      q.readOnly = true;
      q.focus();
      return;
    }
    if (m.type !== 'state') return;
    clearPlan();
    const busy = m.state !== 'idle';
    q.disabled = busy;
    setQueuesBusy(busy);
    bar.classList.toggle('on', busy);
    if (m.state === 'naming') startTick('Routing task…');
    else if (m.state === 'launching') startTick('Starting Claude…');
    // Focus only when the extension says nothing started. A launch ends with the new
    // session's terminal focused, and focusing this textarea would pull the cursor
    // straight back out of it — the box would swallow the first thing typed at Claude.
    else {
      stopTick(); hint.textContent = IDLE;
      // refocus means nothing launched — a cancel or a failure — so the text stays
      // put and the cursor goes back to it. A launched session takes the text with it.
      if (m.refocus) q.focus();
      else { q.value = ''; grow(); }
    }
  });
</script></body></html>`;
  }
}

// ─── asana task lookup ───────────────────────────────────────────────────────
//
// Which Asana task, if any, a session belongs to. The bridge's index (∪ our
// history) is the only source: it records a `permalink` per session id and per
// working dir, so a hit is recorded fact, not inference — nothing is read out of
// transcript contents, and a session with no entry simply gets no link.

module.exports = {
  titleModel, sanitiseSlug, startQueueSession, clientsRoot, projectsRoot, dirsIn, clientDir,
  clientName, clientProject, repoProject, listTargets, findTarget, apiKey, askModel, askApi,
  mailLookupCommand, isMailEntry, findMail, mailTarget, mailContext, askModelCli,
  generateSessionPlan, routingPrompt, fileHead, folderSubject, folderTaskGid, findExistingFolder,
  parseSessionPlan, uniqueDir, KIND_LABEL, decoratePrompt, scratchTarget, targetDir,
  askClaudeSession, listFolderTargets, resolveTypedDir, pickTarget, AskViewProvider,
};
