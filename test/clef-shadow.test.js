#!/usr/bin/env node
// Tests the Clef shadow router in lib/newtask.js: the questions built from the target
// list (255-option cap, repos dropped first), and generateSessionPlan with a stubbed
// Clef — the plan must not wait for it, must not change because of it, and a line must be
// logged once it settles. Haiku is a fake `claude` script; VS Code and jev.js are stubbed.
//
// Run: node test/clef-shadow.test.js
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-clef-'));
const clients = path.join(tmp, 'clients');
fs.mkdirSync(path.join(clients, 'BB'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'projects', 'claude-code-helper'), { recursive: true });
fs.mkdirSync(path.join(tmp, '.cache', 'claude-code-helper'), { recursive: true });
process.env.HOME = tmp;
delete process.env.ANTHROPIC_API_KEY;
const claude = path.join(tmp, 'claude');   // Haiku: always answers the same routing
fs.writeFileSync(claude, '#!/bin/sh\necho \'{"kind":"session","target":"client:BB","slug":"printer-offline"}\'\n', { mode: 0o755 });

const settings = { claudeCommand: claude, clientsDir: clients, projectsDir: path.join(tmp, 'projects'), scratchDir: path.join(tmp, 'tasks'), apiKeyFile: path.join(tmp, 'none'), asanaCommand: '', clefShadow: true };
const vscode = { workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) }, window: {}, ProgressLocation: {} };
const clefCalls = [], shadowed = [];
let clefDelay = 0, clefResult = { kind: { type: 'choice', choice: 'session', confidence: 0.5, probabilities: { session: 0.8, asana: 0.15, email: 0.05 } }, target: { type: 'choice', choice: 'client:BB', confidence: 0.4, probabilities: { 'client:BB': 0.6, none: 0.4 } } };
const jevStub = {
  ask: (a) => { clefCalls.push(a); return new Promise((r) => setTimeout(() => r(clefResult), clefDelay)); },
  shadow: (...args) => shadowed.push(args),
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return vscode;
  if (req === '/home/work/tools/jev/jev.js') return jevStub;
  return origLoad.apply(this, arguments);
};
const nt = require('../lib/newtask');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + JSON.stringify(detail)}`);
  if (!cond) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. Question builder over a plain list.
  const t = [
    { id: 'client:BB', name: 'BB EDV', desc: 'Bergmann GmbH' },
    { id: 'repo:foo', name: 'foo', desc: 'local dev project' },
  ];
  const { questions, dropped } = nt.clefQuestions(t);
  check('kind is a Choice over asana/email/session', JSON.stringify(Object.keys(questions.kind.criteria)) === '["asana","email","session"]', questions.kind);
  check('target options are ids + none, text is name and desc', Object.keys(questions.target.criteria).join() === 'client:BB,repo:foo,none' && questions.target.criteria['client:BB'] === 'BB EDV — Bergmann GmbH', questions.target.criteria);
  check('every question carries instructions', questions.kind.instructions && questions.target.instructions);
  check('nothing dropped under the cap', dropped === 0, dropped);

  // 2. Over the cap: homes stay, repos are dropped, total is exactly the cap including none.
  const big = [{ id: 'client:A', name: 'A', desc: 'a' }];
  for (let i = 0; i < 300; i++) big.push({ id: `repo:r${i}`, name: `r${i}`, desc: 'd' });
  const q2 = nt.clefQuestions(big);
  const keys = Object.keys(q2.questions.target.criteria);
  check('capped at 255 options incl. none', keys.length === nt.CLEF_MAX_OPTIONS && keys.includes('none') && keys.includes('client:A'), keys.length);
  check('dropped counts the repos left out', q2.dropped === 301 - 254, q2.dropped);
  const manyHomes = Array.from({ length: 260 }, (_, i) => ({ id: `client:C${i}`, name: `C${i}`, desc: '' }));
  const q3 = nt.clefQuestions(manyHomes);
  check('even all-homes input stays within the cap', Object.keys(q3.questions.target.criteria).length === nt.CLEF_MAX_OPTIONS);

  // 3. generateSessionPlan with a slow Clef: plan is not delayed, then the line lands.
  clefDelay = 700;
  const t0 = Date.now();
  const plan = await nt.generateSessionPlan('printer at BB not printing', null);
  const took = Date.now() - t0;
  check('plan comes back without waiting for Clef', took < 600 && shadowed.length === 0, { took, n: shadowed.length });
  check('plan is Haiku\'s', plan.kind === 'session' && plan.target && plan.target.id === 'client:BB' && plan.slug === 'printer-offline', plan);
  check('Clef was asked once, with the entry as state', clefCalls.length === 1 && /printer at BB not printing/.test(clefCalls[0].state) && clefCalls[0].questions.kind, clefCalls);
  await wait(900);
  const [site, input, answers, decision, model] = shadowed[0] || [];
  check('shadow line written when Clef settles', shadowed.length === 1 && site === 'newtask-routing' && input === 'printer at BB not printing' && answers && answers.kind.choice === 'session' && answers.target.top['client:BB'] === 0.6 && !answers.kind.probabilities && model === 'clef', shadowed);
  check('line carries haiku + final decisions', decision && decision.haiku.kind === 'session' && decision.haiku.target === 'client:BB' && decision.final.target === 'client:BB', decision);

  // 4. Clef failure: plan unchanged, line logged with null.
  clefDelay = 0; clefResult = null; shadowed.length = 0;
  const p2 = await nt.generateSessionPlan('fix the queue view sorting', null);
  await wait(100);
  check('failed Clef changes nothing and logs jev:null', p2.kind === 'session' && shadowed.length === 1 && shadowed[0][2] === null, shadowed);

  // 5. Switch off.
  settings.clefShadow = false; clefCalls.length = 0; shadowed.length = 0;
  await nt.generateSessionPlan('anything', null);
  await wait(50);
  check('clefShadow=false: no call, no line', clefCalls.length === 0 && shadowed.length === 0, { c: clefCalls.length, s: shadowed.length });

  console.log(failed ? `\n${failed} FAILED` : '\nAll clef-shadow tests passed.');
  process.exit(failed ? 1 : 0);
})();
