#!/usr/bin/env node
// Tests findThreadFolder in lib/newtask.js (2026-10-14, Bergit's "Re: PC issues"): a mail
// whose Gmail thread id is already in a working folder's TASK.md/HANDOFF.md lands in that
// folder, whatever the #inbox/ or #all/ label in the link, and carries the folder's task gid.
//
// Run: node test/thread-folder.test.js
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-thr-'));
const eeb = path.join(tmp, 'clients', 'EEB');
for (const d of ['pc-issues', 'other', 'older']) fs.mkdirSync(path.join(eeb, d), { recursive: true });
fs.writeFileSync(path.join(eeb, 'pc-issues', 'TASK.md'), '# ✨ PC issues\n\n- **Task GID:** 1219436951100916\n- https://mail.google.com/mail/u/0/#all/1a1310405f5e08d0\n');
fs.writeFileSync(path.join(eeb, 'other', 'TASK.md'), '# Other\n- https://mail.google.com/mail/u/0/#all/ffffffffffffffff\n');
fs.writeFileSync(path.join(eeb, 'older', 'HANDOFF.md'), '# Old\nthread 1a1310405f5e08d0 too\n');
fs.utimesSync(path.join(eeb, 'older'), new Date(2020, 1, 1), new Date(2020, 1, 1));
const settings = { clientsDir: path.join(tmp, 'clients'), scratchDir: path.join(tmp, 'tasks'), projectsDir: path.join(tmp, 'projects') };
const vscode = { workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) }, window: {}, QuickPickItemKind: {}, ProgressLocation: {} };
const orig = Module._load;
Module._load = function (req) { return req === 'vscode' ? vscode : orig.apply(this, arguments); };
const nt = require('../lib/newtask');
let failed = 0;
const check = (n, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' — ' + JSON.stringify(d)}`); if (!c) failed++; };
const targets = [{ id: 'client:EEB', name: 'EEB', dir: eeb, create: true }, { id: 'repo:x', name: 'x', dir: path.join(tmp, 'x'), create: false }];
const link = (l) => ({ thread_link: `https://mail.google.com/mail/u/0/#${l}/1a1310405f5e08d0` });

const r = nt.findThreadFolder(link('inbox'), targets);
check('inbox link finds the #all folder, newest wins', r && r.dir === path.join(eeb, 'pc-issues'), r);
check('target is the folder\'s client', r && r.target.id === 'client:EEB', r);
check('task carries the gid and subject', r && r.task && r.task.gid === '1219436951100916' && r.task.name === 'PC issues', r);
check('no match returns null', nt.findThreadFolder({ thread_link: 'https://mail.google.com/mail/u/0/#inbox/aaaaaaaaaaaa' }, targets) === null);
check('no link returns null', nt.findThreadFolder({}, targets) === null && nt.findThreadFolder(null, targets) === null);
process.exit(failed ? 1 : 0);
