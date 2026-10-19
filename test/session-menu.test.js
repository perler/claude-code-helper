#!/usr/bin/env node
// Pins the Recent Sessions right-click entries (2026-10-15): Start New Session Here on every
// row, Resume and Compact only on rows that are not running.
// Run: node test/session-menu.test.js
const pkg = require('../package.json');
let failed = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failed++; };
const items = pkg.contributes.menus['view/item/context'];
const whenFor = (cmd) => items.filter((i) => i.command === cmd);
const matches = (cmd, v) => whenFor(cmd).some((i) => {
  const m = i.when.match(/viewItem =~ \/(.*?)\//);
  return i.when.includes('claudeHelper.sessions') && m && new RegExp(m[1]).test(v);
});
const all = ['session', 'sessionLive', 'sessionAsana', 'sessionLiveAsana'];
for (const c of ['startClaude', 'openTerminalHere', 'revealInExplorer', 'openFolder', 'copyPath'])
  for (const v of all) check(`${c} on ${v}`, matches(`claudeHelper.${c}`, v));
for (const v of all) check(`resumeAndCompact ${/Live/.test(v) ? 'absent' : 'present'} on ${v}`, matches('claudeHelper.resumeAndCompact', v) === !/Live/.test(v));
const cmds = pkg.contributes.commands.map((c) => c.command);
check('commands declared', !cmds.includes('claudeHelper.newSessionHere') && cmds.includes('claudeHelper.resumeAndCompact'));
const grp = (c) => whenFor(c).find((i) => !i.group.startsWith('inline')).group;
check('run group: start, resume, compact', grp('claudeHelper.startClaude') === '1_run@1' && grp('claudeHelper.resumeSession') === '1_run@2' && grp('claudeHelper.resumeAndCompact') === '1_run@3');
check('hover buttons match Favourites', ['startClaude', 'resumeSession', 'revealInExplorer'].every((c, n) => whenFor(`claudeHelper.${c}`).some((i) => i.group === `inline@${n + 1}` && i.when.includes('claudeHelper.sessions'))));
process.exit(failed ? 1 : 0);
