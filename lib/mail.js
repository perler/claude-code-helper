const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const { cfg, expandHome } = require('./shared');

// ── the inbox behind the ✉️ button ───────────────────────────────────────────
//
// Same shape as the Asana half: the script does the reading, this file only decides
// whether it exists, caches what it printed and hands it to the view. A workstation
// without the script gets no button rather than one that fails on every click.

let _mailAvailable;
function mailAvailable() {
  if (_mailAvailable !== undefined) return _mailAvailable;
  _mailAvailable = false;
  try {
    const bin = expandHome(((cfg().get('mailInboxCommand') || '').trim().split(/\s+/)[0]) || '');
    if (bin) { fs.accessSync(bin, fs.constants.X_OK); _mailAvailable = true; }
  } catch {}
  return _mailAvailable;
}

function forgetMailAvailable() { _mailAvailable = undefined; }

function mailInboxCommand() { return mailAvailable() ? expandHome((cfg().get('mailInboxCommand') || '').trim()) : ''; }

function mailCacheFile() { return path.join(os.homedir(), '.cache', 'claude-code-helper', 'mail-inbox.json'); }

function loadMailInbox() {
  try {
    const j = JSON.parse(fs.readFileSync(mailCacheFile(), 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function mailCacheAge() {
  try { return Date.now() - fs.statSync(mailCacheFile()).mtimeMs; } catch { return Infinity; }
}

// The whole list, not a count: the count is `list.length`, so the button's number and
// the picker's rows can never disagree, and a click inside the cache window opens the
// picker with no IMAP round trip at all.
//
// Login + SELECT against Gmail costs 4-10s from here, so nothing waits on this: a stale
// list still opens, a missing one only costs the number on the button.
function refreshMailInbox(maxAgeMs, done) {
  // Always called, exactly once, whatever happened — the picker awaits this, so a
  // failed read has to come back as "the cached list" rather than as a spinner that
  // never stops.
  let sent = false;
  const finish = (list) => { if (sent || !done) return; sent = true; try { done(list || loadMailInbox()); } catch {} };
  const cmd = mailInboxCommand();
  if (!cmd) return finish(null);
  if (maxAgeMs && mailCacheAge() < maxAgeMs) return finish(null);
  const tokens = cmd.split(/\s+/);
  let child;
  try {
    child = cp.execFile(tokens[0], tokens.slice(1), { timeout: 60000, maxBuffer: 1 << 22 }, (err, stdout) => {
      let list;
      try { list = JSON.parse(String(stdout || '')); } catch {}
      if (err || !Array.isArray(list)) return finish(null);
      const file = mailCacheFile();
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list));
      } catch {}
      finish(list);
    });
  } catch { return finish(null); }
  child.on('error', () => finish(null));
}

// What the box would have been typed as. The routing call is built around an entry in
// the box, and a picked mail is one — this is that entry, so a mail reaches the router
// through exactly the same path as "email <subject>" typed by hand.
function mailEntry(mail) { return `email ${String((mail && mail.subject) || '').trim()}`; }

// The prompt behind "all messages". It hands the session the script rather than the
// list: by the time it reads it, ours is minutes old.
function triagePrompt(cmd) {
  return [
    'Triage my Gmail inbox — the mail addressed to @erler-edv-beratung.de.',
    '',
    `Run \`${cmd}\` for the list: subject, sender, date, read state, the client shortcode`,
    'the sender resolves to, and the Gmail thread link.',
    '',
    'Read every one of them — the Gmail MCP for the full thread wherever the subject does not',
    'already say what it wants — then give me ONE numbered table, one row per mail:',
    'number, sender, subject, what it wants, and the action you propose (file it as an Asana',
    'task in <project> / draft a reply / archive, nothing to do / needs a decision from me).',
    'No grouping, no "and the rest" — every mail gets its own row and its own number.',
    '',
    'Then stop and wait. I answer by number; you execute the approved rows in blocks of five',
    'and report back. Nothing is sent and no task is created before I approve its row.',
  ].join('\n');
}

module.exports = {
  mailAvailable, forgetMailAvailable, mailInboxCommand, mailCacheFile,
  loadMailInbox, mailCacheAge, refreshMailInbox, mailEntry, triagePrompt,
};
