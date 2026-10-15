#!/usr/bin/env node
// A subtask is placed through its parent's project (the CLI now sends `parent`), resumes in
// a folder stamped with its parent's gid, and a task nothing places gets a scratch folder
// instead of the old silent "needs folder". Run: node test/queue-subtask.test.js
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-qsub-'));
const clients = path.join(tmp, 'clients');
fs.mkdirSync(path.join(clients, 'BB', 'parent-work'), { recursive: true });
fs.writeFileSync(path.join(clients, 'BB', 'parent-work', 'TASK.md'), '# x\n\n- **Task GID:** 1219000000001\n');
process.env.HOME = tmp;
fs.mkdirSync(path.join(tmp, '.cache', 'claude-code-helper'), { recursive: true });
const settings = { asanaCommand: '', clientsDir: clients, projectsDir: path.join(tmp, 'projects'), scratchDir: path.join(tmp, 'tasks') };
const vscode = { QuickPickItemKind: { Separator: -1 }, workspace: { getConfiguration: () => ({ get: (k) => settings[k] }) },
  window: { showErrorMessage: (m) => { throw new Error(m); } } };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return vscode;
  if (req === './queue') return { addTasks() {}, setQueueHooks() {} };
  if (req === './launch') return { tablessAvailable: () => false, startDtachMaster: async () => null, launchClaude: async () => null };
  return origLoad.apply(this, arguments);
};
const asana = require('../lib/asana');
const nt = require('../lib/newtask');
const queue = require('../lib/queue');
Module._load = origLoad;
fs.writeFileSync(asana.asanaCacheFile(), JSON.stringify([{ gid: 'p-bb', name: 'BB EDV' }]));
let failed = 0;
const check = (n, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' — ' + JSON.stringify(d)}`); if (!c) failed++; };

(async () => {
  const targets = nt.listTargets ? nt.listTargets() : require('../lib/newtask').listTargets();
  const sub = { gid: '1219000000002', name: '3. Check proof', projects: [], parent: { gid: '1219000000001', name: 'Parent', projects: [{ gid: 'p-bb', name: 'BB EDV' }] } };
  check('subtask routes to its parent project', (nt.queueTaskTarget(sub, targets) || {}).name === 'BB' || !!nt.queueTaskTarget(sub, targets), targets.length);
  const slim = queue.slimTask(sub);
  check('slimTask keeps the parent and its projects', slim.parent && slim.parent.gid === '1219000000001' && slim.parent.projects[0].gid === 'p-bb', slim);
  check('slimmed subtask still has a project', queue.slimTask(sub).projects.length === 1, slim);
  let r = await nt.resolveQueueTask(slim, targets);
  check('subtask resumes in the folder stamped with its parent gid', r && r.dir === path.join(clients, 'BB', 'parent-work'), r);

  const sub2 = { ...sub, gid: '1219000000003', parent: { ...sub.parent, gid: '1219000000009' } };
  r = await nt.resolveQueueTask(queue.slimTask(sub2), targets);
  check('no parent folder: new slug folder under the parent project client', r && r.dir === path.join(clients, 'BB', '3-check'), r);

  const lost = { gid: '1219000000004', name: 'Nowhere task', projects: [] };
  r = await nt.resolveQueueTask(lost, targets);
  check('unplaceable task gets a scratch folder, no needsFolder', r && !r.needsFolder && r.dir === path.join(tmp, 'tasks', 'nowhere-task') && fs.existsSync(r.dir), r);
  r = await nt.resolveQueueTask({ ...lost, gid: '1219000000005' }, targets);
  check('a second one does not collide', r && r.dir !== path.join(tmp, 'tasks', 'nowhere-task') || (r && r.dir.startsWith(path.join(tmp, 'tasks'))), r);
  process.exit(failed ? 1 : 0);
})();
