#!/usr/bin/env node
// Tests the Live Session panel's data layer: which session a terminal is showing,
// what it changed, and what it just did. Only VS Code is stubbed — the transcripts,
// the session files, the processes and the git repository are real, because every
// one of those formats is something the CLI writes and can change under us.
//
// Run: node test/live-panel.test.js
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const Module = require('module');

// ─── the stub VS Code sees ───────────────────────────────────────────────────
const settings = {};
const vscode = {
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  ViewColumn: { One: 1, Beside: -2 },
  Uri: class Uri {
    constructor(p) { this.scheme = 'file'; this.fsPath = p; }
    static file(p) { return new Uri(p); }
    static from(o) { return Object.assign(new Uri(o.path), o); }
    toString() { return this.scheme + ':' + (this.fsPath || this.path) + (this.query ? '?' + this.query : ''); }
  },
  EventEmitter: class {
    constructor() { this.event = () => ({ dispose() {} }); }
    fire() {}
  },
  MarkdownString: class { appendMarkdown() { return this; } },
  window: {
    terminals: [], activeTerminal: undefined, state: { focused: true },
    createWebviewPanel: () => { throw new Error('not exercised here'); },
    showInformationMessage() {}, showWarningMessage() {},
  },
  commands: { executeCommand: () => Promise.resolve() },
  extensions: { getExtension: (id) => gitExt[id] || undefined },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return realLoad(request, parent, isMain);
};

// What vscode.extensions.getExtension('vscode.git') answers; swapped per test.
const gitExt = {};

const REAL_HOME = os.homedir();
const live = require('../lib/livepanel.js');

// ─── assertions ──────────────────────────────────────────────────────────────
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
function section(s) { console.log(`\n${s}`); }

// ─── toolItem: one row per tool call, in a column ~40 characters wide ────────
section('toolItem');
{
  const bash = live.toolItem({ name: 'Bash', input: { command: 'ls -la\nsecond line', description: 'List files' } }, 't');
  ok('Bash prefers its description', bash.text === 'List files' && bash.label === '$', JSON.stringify(bash));
  ok('Bash keeps the full command as the tooltip', bash.title.includes('second line'));

  const noDesc = live.toolItem({ name: 'Bash', input: { command: 'make\nall' } }, 't');
  ok('Bash with no description shows the first line', noDesc.text === 'make', JSON.stringify(noDesc));

  const read = live.toolItem({ name: 'Read', input: { file_path: '/home/work/projects/x/lib/a.js' } }, 't');
  ok('a file tool shows the basename', read.text === 'a.js' && read.label === 'Read', JSON.stringify(read));
  ok('a file tool is clickable', read.file === '/home/work/projects/x/lib/a.js');

  const agent = live.toolItem({ name: 'Agent', input: { description: 'Find the bug', prompt: 'long…' } }, 't');
  ok('Agent shows its description', agent.text === 'Find the bug', JSON.stringify(agent));

  const other = live.toolItem({ name: 'WebSearch', input: { query: 'xterm cols' } }, 't');
  ok('an unknown tool falls back to a recognisable argument', other.text === 'xterm cols', JSON.stringify(other));

  const bare = live.toolItem({ name: 'Mystery', input: {} }, 't');
  ok('a tool with nothing to show still renders', bare.label === 'Mystery' && bare.text === '', JSON.stringify(bare));

  const ided = live.toolItem({ name: 'Bash', id: 'toolu_1', input: { command: 'echo hi' } }, 't', 'u-1');
  ok('a tool row carries the ids a record lookup needs',
    ided.uuid === 'u-1' && ided.toolId === 'toolu_1', JSON.stringify(ided));
}

// ─── anchor: what "Find in terminal" can actually match ─────────────────────
section('anchor');
{
  ok('an anchor is one line', live.anchor('first line\nsecond line') === 'first line');
  ok('an anchor collapses whitespace', live.anchor('a   b\tc') === 'a b c');
  ok('an anchor is short enough not to straddle a wrap',
    live.anchor('x'.repeat(200)).length === 28, String(live.anchor('x'.repeat(200)).length));
  ok('an anchor does not end mid-space', live.anchor('word '.repeat(20)) === live.anchor('word '.repeat(20)).trim());

  // A Bash row is LABELLED with its description but the terminal prints the
  // command, so the anchor has to come from the command.
  const b = live.toolItem({ name: 'Bash', input: { command: 'grep -rn needle src/', description: 'Search for the needle' } }, 't', 'u');
  ok('a Bash anchor is the command, not the description', b.anchor === 'grep -rn needle src/', b.anchor);
}

// ─── fence: a code block that cannot be broken by its own contents ──────────
section('fence');
{
  ok('a plain body gets a three-backtick fence', live.fence('hi', 'sh') === '```sh\nhi\n```', JSON.stringify(live.fence('hi', 'sh')));
  const withFence = live.fence('before\n```\nafter');
  ok('a body containing a fence gets a longer one', withFence.startsWith('````\n') && withFence.endsWith('\n````'), JSON.stringify(withFence));
  const withLong = live.fence('a ````` b');
  ok('the fence always beats the longest run inside', withLong.startsWith('``````'), JSON.stringify(withLong.slice(0, 10)));
  ok('trailing blank lines do not push the closing fence away', live.fence('x\n\n\n') === '```\nx\n```');
}

// ─── readActivity: a synthetic transcript with every record shape ────────────
section('readActivity');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-live-'));
  const f = path.join(dir, 's.jsonl');
  const rec = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(f, [
    rec({ type: 'user', message: { content: 'first prompt' }, timestamp: '2026-09-04T06:00:00Z' }),
    rec({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List' } }] } }),
    // a tool_result comes back as a `user` record and must NOT read as a prompt
    rec({ type: 'user', message: { content: [{ type: 'tool_result', content: 'total 0' }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
    rec({ type: 'summary', summary: 'ignored' }),
    'not json at all',
  ].join(''));

  const a = live.readActivity(f);
  ok('newest first', a[0].text === 'Done.', JSON.stringify(a.map((x) => x.text)));
  ok('a prompt is a "you" row', a.some((x) => x.kind === 'you' && x.text === 'first prompt'));
  ok('a tool_result is not a prompt', a.filter((x) => x.kind === 'you').length === 1, JSON.stringify(a));
  ok('thinking blocks are skipped', !a.some((x) => (x.text || '').includes('hmm')));
  ok('a broken line does not stop the parse', a.length === 3, JSON.stringify(a));
}

// ─── readActivity against a real transcript ─────────────────────────────────
{
  const root = path.join(REAL_HOME, '.claude', 'projects');
  let real = null;
  try {
    for (const p of fs.readdirSync(root)) {
      for (const f of fs.readdirSync(path.join(root, p))) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(root, p, f);
        if (fs.statSync(full).size > 200000) { real = full; break; }
      }
      if (real) break;
    }
  } catch { /* no transcripts on this box — the synthetic test still ran */ }
  if (!real) {
    console.log('  skip real transcript (none found)');
  } else {
    const a = live.readActivity(real);
    ok('a real transcript yields rows', a.length > 0, real);
    ok('a real transcript is capped', a.length <= 60, `${a.length}`);
    ok('every row has a kind and text', a.every((x) => x.kind && typeof x.text === 'string'));
    ok('tail-reading never returns a half-parsed row', a.every((x) => x.text !== undefined));
  }
}

// ─── renderRecord: the whole turn behind a one-line row ────────────────────
section('renderRecord');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-live-'));
  const f = path.join(dir, 's.jsonl');
  const rec = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(f, [
    rec({ type: 'user', uuid: 'u-prompt', timestamp: '2026-09-04T06:00:00.000Z', cwd: '/repo',
          message: { content: 'do the thing' } }),
    rec({ type: 'assistant', uuid: 'u-say', timestamp: '2026-09-04T06:00:01.000Z', cwd: '/repo',
          message: { content: [{ type: 'text', text: 'On it.' }] } }),
    rec({ type: 'assistant', uuid: 'u-tool', timestamp: '2026-09-04T06:00:02.000Z', cwd: '/repo', gitBranch: 'main',
          message: { content: [{ type: 'tool_use', id: 'toolu_A', name: 'Bash',
                                 input: { command: 'ls -la', description: 'List files' } }] } }),
    // an attachment sits between the call and its result, as it does in real transcripts
    rec({ type: 'attachment', uuid: 'u-att', attachment: { type: 'noise' } }),
    rec({ type: 'user', uuid: 'u-res', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_A', content: 'total 0\ndrwx' }] } }),
    rec({ type: 'assistant', uuid: 'u-tool2', timestamp: '2026-09-04T06:00:05.000Z', gitBranch: 'HEAD',
          message: { content: [{ type: 'tool_use', id: 'toolu_B', name: 'Read',
                                 input: { file_path: '/repo/a.js' } }] } }),
    rec({ type: 'user', uuid: 'u-res2', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_B', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } }),
    rec({ type: 'assistant', uuid: 'u-pending', timestamp: '2026-09-04T06:00:09.000Z',
          message: { content: [{ type: 'tool_use', id: 'toolu_C', name: 'Bash', input: { command: 'sleep 99' } }] } }),
  ].join(''));

  const prompt = live.renderRecord(f, 'u-prompt', null);
  ok('a prompt renders under a You heading', prompt.startsWith('# You ·'), prompt.split('\n')[0]);
  ok('a prompt renders its full text', prompt.includes('do the thing'));

  const say = live.renderRecord(f, 'u-say', null);
  ok('a reply renders under a Claude heading', say.startsWith('# Claude ·'), say.split('\n')[0]);
  ok('a reply renders its text', say.includes('On it.'));

  const bash = live.renderRecord(f, 'u-tool', 'toolu_A');
  ok('a tool record is headed by the tool name', bash.startsWith('# Bash ·'), bash.split('\n')[0]);
  ok('a tool record shows where it ran', bash.includes('/repo') && bash.includes('branch main'), bash);
  ok('a Bash record fences its command', bash.includes('```sh\nls -la\n```'), bash);
  ok('a Bash record keeps its description', bash.includes('_List files_'));
  ok('a tool record carries its result past an intervening attachment',
    bash.includes('## Result') && bash.includes('total 0'), bash);
  ok('a successful result is not flagged as an error', !bash.includes('Result — error'));

  const read = live.renderRecord(f, 'u-tool2', 'toolu_B');
  ok('a non-Bash tool renders its input as json', read.includes('```json') && read.includes('"file_path"'), read);
  ok('an errored result says so', read.includes('## Result — error'), read);
  ok('a block-array result is flattened to text', read.includes('boom'), read);
  // Outside a repository the CLI writes the branch as the literal "HEAD", which
  // reads like a real branch name and says nothing.
  ok('a detached "branch HEAD" is not printed as a branch', !read.includes('branch HEAD'), read);

  const pending = live.renderRecord(f, 'u-pending', 'toolu_C');
  ok('a call with no result yet says it is still running', pending.includes('Still running'), pending);

  ok('an unknown record does not throw', live.renderRecord(f, 'nope', null).includes('no longer in the transcript window'));
  ok('a missing file does not throw', typeof live.renderRecord(path.join(dir, 'gone.jsonl'), 'u-say', null) === 'string');
  ok('no uuid, nothing to show', live.renderRecord(f, '', null) === 'Nothing to show.');

  // The uri a click builds has to survive round-tripping through the provider.
  const uri = live.recordUri(f, { uuid: 'u-tool', toolId: 'toolu_A', label: '$', ts: '2026-09-04T06:00:02.000Z' });
  ok('the record uri names the transcript, the record and the tool',
    uri.query.includes('uuid=u-tool') && uri.query.includes('tool=toolu_A') && uri.query.includes(encodeURIComponent(f)),
    uri.query);
  ok('the record uri has a readable filename', /\.md$/.test(uri.path), uri.path);
  ok('the uri path is filesystem-safe', !/[^A-Za-z0-9/.\-]/.test(uri.path), uri.path);
  // '$' is the Bash row's label and sanitises to nothing; the tab must still say Bash.
  const bashUri = live.recordUri(f, live.toolItem({ name: 'Bash', id: 't1', input: { command: 'ls' } }, '2026-09-04T06:00:02.000Z', 'u-tool'));
  ok('a Bash record tab is named after the tool, not its "$" label',
    bashUri.path === '/Bash-060002.md', bashUri.path);
  ok('a prompt record tab says who said it',
    live.recordUri(f, { uuid: 'u', kind: 'you', ts: '2026-09-04T06:00:00.000Z' }).path === '/You-060000.md');
}

// ─── touchedFromTranscript ──────────────────────────────────────────────────
section('touchedFromTranscript');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-live-'));
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, JSON.stringify({
    type: 'file-history-snapshot',
    snapshot: { trackedFileBackups: {
      'package.json': { realParentDir: '/repo' },
      'lib/sessions.js': { realParentDir: '/repo/lib' },
    } },
  }) + '\n');
  const t = live.touchedFromTranscript(f).sort((a, b) => a.rel.localeCompare(b.rel));
  ok('two files', t.length === 2, JSON.stringify(t));
  ok('a nested file gets its real absolute path', t[0].path === '/repo/lib/sessions.js', JSON.stringify(t[0]));
  ok('a top-level file gets its real absolute path', t[1].path === '/repo/package.json', JSON.stringify(t[1]));
}

// ─── gitHeadUri: the diff a click can actually produce ─────────────────────
section('gitHeadUri');
{
  const uri = vscode.Uri.file('/repo/lib/a.js');
  ok('no git extension, no diff', live.gitHeadUri(uri) === null);

  gitExt['vscode.git'] = { isActive: false, exports: {} };
  ok('an inactive git extension yields no diff', live.gitHeadUri(uri) === null);

  const api = {
    repositories: [{ rootUri: { fsPath: '/other' } }],
    toGitUri: (u, ref) => ({ scheme: 'git', fsPath: u.fsPath, ref }),
  };
  gitExt['vscode.git'] = { isActive: true, exports: { getAPI: () => api } };
  ok('a file outside every open repository yields no diff', live.gitHeadUri(uri) === null);

  api.repositories = [{ rootUri: { fsPath: '/repo' } }];
  const head = live.gitHeadUri(uri);
  ok('a file inside an open repository yields its HEAD uri',
    head && head.scheme === 'git' && head.ref === 'HEAD', JSON.stringify(head));

  // The repository root itself, and a sibling whose name merely starts the same.
  ok('the repository root counts as inside it', live.gitHeadUri(vscode.Uri.file('/repo')) !== null);
  ok('a sibling with a shared prefix is not inside it',
    live.gitHeadUri(vscode.Uri.file('/repository/a.js')) === null);
  delete gitExt['vscode.git'];
}

// ─── gitChanges ─────────────────────────────────────────────────────────────
section('gitChanges');
(async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-live-'));
  ok('a directory that is not a repository answers null, not empty',
    (await live.gitChanges(notRepo)) === null);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-live-'));
  const g = (...args) => cp.execFileSync('git', ['-C', repo, ...args],
    { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'lib'));
  fs.writeFileSync(path.join(repo, 'lib', 'a.js'), 'one\ntwo\nthree\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');

  ok('a clean tree answers an empty list', (await live.gitChanges(repo)).length === 0);

  fs.writeFileSync(path.join(repo, 'lib', 'a.js'), 'one\ntwo\nthree\nfour\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hi\n');
  const rows = await live.gitChanges(repo);
  const byRel = Object.fromEntries(rows.map((r) => [r.rel, r]));
  ok('a modified file is listed', byRel['lib/a.js'] && byRel['lib/a.js'].status === 'M', JSON.stringify(rows));
  ok('an untracked file is listed', byRel['new.txt'] && byRel['new.txt'].status === '??', JSON.stringify(rows));
  ok('paths are absolute so a click can open them',
    rows.every((r) => path.isAbsolute(r.path)), JSON.stringify(rows.map((r) => r.path)));
  ok('a modified file carries its line counts',
    byRel['lib/a.js'].add === 1 && byRel['lib/a.js'].del === 0, JSON.stringify(byRel['lib/a.js']));

  // A rename is reported as "old -> new"; the new name is the one that exists.
  g('mv', 'lib/a.js', 'lib/b.js');
  const renamed = await live.gitChanges(repo);
  ok('a rename lists the new name', renamed.some((r) => r.rel === 'lib/b.js'), JSON.stringify(renamed));
  ok('a rename does not leak the arrow', !renamed.some((r) => r.rel.includes('->')), JSON.stringify(renamed));

  // ─── resolveSession: the cwd routes, against a temp HOME ──────────────────
  section('resolveSession');
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-live-home-'));
  const realHomeEnv = process.env.HOME;
  process.env.HOME = HOME;
  fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });

  const work = path.join(HOME, 'work');
  fs.mkdirSync(work);
  const projDir = path.join(HOME, '.claude', 'projects', work.replace(/\//g, '-'));
  fs.mkdirSync(projDir, { recursive: true });

  const mkTranscript = (id, at) => {
    const f = path.join(projDir, `${id}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'user', cwd: work, message: { content: 'hi' }, timestamp: at }) + '\n');
    return f;
  };
  const older = '11111111-1111-1111-1111-111111111111';
  const newer = '22222222-2222-2222-2222-222222222222';
  mkTranscript(older, '2026-09-01T00:00:00.000Z');
  mkTranscript(newer, '2026-09-03T00:00:00.000Z');

  const procStartOf = (pid) => {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return st.slice(st.lastIndexOf(')') + 2).split(' ')[19];
  };
  const kids = [];
  const startLive = (sessionId, cwd, status, entrypoint) => {
    const child = cp.spawn('sleep', ['60'], { cwd, stdio: 'ignore' });
    kids.push(child);
    fs.writeFileSync(path.join(HOME, '.claude', 'sessions', `${child.pid}.json`),
      JSON.stringify({ pid: child.pid, cwd, sessionId, status, entrypoint: entrypoint || 'cli', procStart: procStartOf(child.pid), name: 'work' }));
    return child.pid;
  };

  const terminalIn = (dir) => ({ name: 'x', creationOptions: { cwd: dir }, processId: Promise.resolve(null) });

  ok('no terminal, no session', live.resolveSession(null) === null);

  // Nothing running: the newest transcript in the folder is what the terminal shows.
  const idle = live.resolveSession(terminalIn(work));
  ok('an idle folder resolves to its newest transcript', idle && idle.sessionId === newer, JSON.stringify(idle));
  ok('an idle folder has no live record', idle && !idle.live);

  // One live session in the folder — that is the answer, even though it is the
  // OLDER transcript, which is exactly the case the newest-file rule gets wrong.
  startLive(older, work, 'busy');
  const one = live.resolveSession(terminalIn(work));
  ok('one live session in the folder wins over the newest file', one && one.sessionId === older, JSON.stringify(one));
  ok('a live session carries its status', one && one.live && one.live.status === 'busy');

  // The Claude Code sidebar opens a session of its own in every window; it has no
  // terminal, so counting it would blank the panel for the session that does.
  startLive('99999999-9999-9999-9999-999999999999', work, 'idle', 'claude-vscode');
  const withSidebar = live.resolveSession(terminalIn(work));
  ok('the sidebar\'s own session does not make the folder ambiguous',
    withSidebar && withSidebar.sessionId === older, JSON.stringify(withSidebar));

  // Two real live sessions in one folder: the directory cannot say which tab is
  // which, and a panel pointed at the wrong session is worse than a blank one.
  startLive(newer, work, 'idle');
  ok('two live sessions in one folder resolve to nothing',
    live.resolveSession(terminalIn(work)) === null);

  for (const k of kids) { try { k.kill(); } catch {} }
  process.env.HOME = realHomeEnv;

  console.log(failed ? `\n${failed} failing\n` : '\nall passing\n');
  process.exit(failed ? 1 : 0);
})();
