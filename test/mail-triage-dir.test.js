#!/usr/bin/env node
// Tests mailTriageDir in lib/newtask.js (2026-10-15): a triage session starts in a
// subfolder — the shared thread folder, else the shared client's folder, else a new
// tasks/mail-triage-<stamp> folder — never in the home directory.
//
// Run: node test/mail-triage-dir.test.js
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-tri-'));
const eeb = path.join(tmp, 'clients', 'EEB'), rah = path.join(tmp, 'clients', 'RAH');
for (const d of [path.join(eeb, 'pc-issues'), rah, path.join(tmp, 'tasks')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(eeb, 'pc-issues', 'TASK.md'), '# PC\n- https://mail.google.com/mail/u/0/#all/aaaaaaaaaaaa1111\n- https://mail.google.com/mail/u/0/#all/bbbbbbbbbbbb2222\n');
const settings = { clientsDir: path.join(tmp, 'clients'), scratchDir: path.join(tmp, 'tasks'), projectsDir: path.join(tmp, 'projects') };
const vscode = { workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) }, window: {}, QuickPickItemKind: {}, ProgressLocation: {} };
const orig = Module._load;
Module._load = function (req) { return req === 'vscode' ? vscode : orig.apply(this, arguments); };
const nt = require('../lib/newtask');
let failed = 0;
const check = (n, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' — ' + JSON.stringify(d)}`); if (!c) failed++; };
const targets = [{ id: 'client:EEB', name: 'EEB', dir: eeb, create: true }, { id: 'client:RAH', name: 'RAH', dir: rah, create: true }];
const m = (id, client) => ({ thread_link: `https://mail.google.com/mail/u/0/#inbox/${id}`, client });

let r = nt.mailTriageDir([m('aaaaaaaaaaaa1111'), m('bbbbbbbbbbbb2222')], targets);
check('(a) both threads in one folder -> that folder', r.dir === path.join(eeb, 'pc-issues') && !r.create, r);
r = nt.mailTriageDir([m('cccccccccccc3333', 'RAH'), m('dddddddddddd4444', 'RAH')], targets);
check('(b) same client, no thread hit -> client folder', r.dir === rah && !r.create, r);
r = nt.mailTriageDir([m('cccccccccccc3333', 'RAH'), m('dddddddddddd4444', 'EEB')], targets);
check('(c) mixed clients -> new scratch dir', r.create && path.dirname(r.dir) === path.join(tmp, 'tasks') && /mail-triage-\d{4}-\d\d-\d\d-\d{4}$/.test(r.dir), r);
fs.mkdirSync(r.dir);
check('(c) created dir is not reused', nt.mailTriageDir([m('x1'), m('y2')], targets).dir !== r.dir);
r = nt.mailTriageDir([], targets);
check('(d) empty list -> scratch', r.create && /mail-triage-/.test(r.dir), r);
r = nt.mailTriageDir([m('aaaaaaaaaaaa1111'), m('cccccccccccc3333', 'EEB')], targets);
check('thread folder + other mail of same client -> client folder', r.dir === eeb, r);
process.exit(failed ? 1 : 0);
