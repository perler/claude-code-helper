#!/usr/bin/env node
// Tests moveTerminalTabToEnd — the real function out of lib/launch.js, against a stub
// tab strip that behaves like VS Code's: a new terminal's tab appears, and becomes
// active, some time AFTER createTerminal() + show() return.
//
// The bug this pins (fixed in 0.57.1): launched from another session tab, the function
// moved THAT tab to the end — it was still the active one — and the new tab opened in
// its place.
//
// Run: node test/move-tab.test.js
const fs = require('fs'), path = require('path');

class TabInputTerminal {}
class TabInputText {}
const termTab = (label) => ({ label, input: new TabInputTerminal() });
const fileTab = (label) => ({ label, input: new TabInputText() });

let group, moves;
const vscode = {
  TabInputTerminal,
  window: {
    activeTerminal: undefined,
    tabGroups: { get all() { return [group]; }, get activeTabGroup() { return group; } },
  },
  commands: {
    // What the real command does: the ACTIVE tab goes to the end.
    async executeCommand(cmd, arg) {
      if (cmd !== 'moveActiveEditor' || arg.to !== 'last') throw new Error(`unexpected command ${cmd}`);
      moves.push(group.activeTab.label);
      group.tabs = group.tabs.filter((t) => t !== group.activeTab).concat(group.activeTab);
    },
  },
};

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'launch.js'), 'utf8');
const from = src.indexOf('async function moveTerminalTabToEnd');
const to = src.indexOf('\nfunction runInInternalTerminal');
if (from < 0 || to < from) { console.log('FAIL could not find moveTerminalTabToEnd in lib/launch.js'); process.exit(1); }
const moveTerminalTabToEnd = new Function('vscode', `${src.slice(from, to)}; return moveTerminalTabToEnd;`)(vscode);

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + JSON.stringify(detail)}`);
  if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const order = () => group.tabs.map((t) => t.label);

// A strip of [file, session A, session B, file] with `active` in front, and a terminal
// for the session being launched. Returns the terminal and a function that makes its
// tab appear right of the active one and take over, as VS Code does.
function scene(active, newName) {
  const tabs = [fileTab('readme.md'), termTab('alpha'), termTab('beta'), fileTab('notes.md')];
  group = { tabs, activeTab: tabs.find((t) => t.label === active) };
  moves = [];
  const terminalA = { name: 'alpha', creationOptions: { name: 'alpha' } };
  vscode.window.activeTerminal = terminalA;
  const terminal = { name: newName, creationOptions: { name: newName } };
  const tab = termTab(newName);
  return {
    terminal,
    tabAppears() {
      const at = group.tabs.indexOf(group.activeTab) + 1;
      group.tabs = group.tabs.slice(0, at).concat(tab, group.tabs.slice(at));
      group.activeTab = tab;
    },
    terminalActive() { vscode.window.activeTerminal = terminal; },
  };
}

(async () => {
  // 1. The reported bug: launching while on another session's tab.
  {
    const s = scene('alpha', 'gamma');
    const done = moveTerminalTabToEnd(s.terminal);
    await sleep(120);
    check('launched from a session tab: nothing moves before the new tab is up', moves.length === 0, moves);
    s.tabAppears(); s.terminalActive();
    await done;
    check('launched from a session tab: only the new tab moves', moves.join() === 'gamma', moves);
    check('launched from a session tab: the others keep their order',
      order().join() === 'readme.md,alpha,beta,notes.md,gamma', order());
  }

  // 2. Same, with a new session named like the one in front (two sessions in one
  //    folder), and the active terminal switching before the tab strip catches up.
  {
    const s = scene('alpha', 'alpha');
    const done = moveTerminalTabToEnd(s.terminal);
    s.terminalActive();
    await sleep(120);
    check('same-named session, tab strip lagging: the old tab stays put', moves.length === 0, moves);
    s.tabAppears();
    await done;
    check('same-named session: the new tab ends up last, the old one where it was',
      moves.length === 1 && order().join() === 'readme.md,alpha,beta,notes.md,alpha' && group.tabs[4] === group.activeTab, order());
  }

  // 3. The terminal opened in the bottom panel: no new editor tab ever appears.
  {
    const s = scene('alpha', 'gamma');
    const done = moveTerminalTabToEnd(s.terminal);
    s.terminalActive();
    await done;
    check('terminal opened in the panel: nothing moves', moves.length === 0 && order().join() === 'readme.md,alpha,beta,notes.md', { moves, order: order() });
  }

  // 4. Launched from the last tab: the new tab is already at the end.
  {
    const s = scene('notes.md', 'gamma');
    const done = moveTerminalTabToEnd(s.terminal);
    s.tabAppears(); s.terminalActive();
    await done;
    check('new tab already last: no move', moves.length === 0 && order().join() === 'readme.md,alpha,beta,notes.md,gamma', { moves, order: order() });
  }

  // 5. Launched from a file tab in the middle.
  {
    const s = scene('readme.md', 'gamma');
    const done = moveTerminalTabToEnd(s.terminal);
    await sleep(60);
    s.tabAppears(); s.terminalActive();
    await done;
    check('launched from a file tab: the new tab moves to the end',
      moves.join() === 'gamma' && order().join() === 'readme.md,alpha,beta,notes.md,gamma', { moves, order: order() });
  }

  // 6. No terminal handed in: do nothing rather than guess.
  {
    scene('alpha', 'gamma');
    await moveTerminalTabToEnd();
    check('called without a terminal: nothing moves', moves.length === 0, moves);
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
