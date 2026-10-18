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
// With `mails` (the ones ticked in the picker, 2026-10-15) it covers only those, listed
// here because Pat chose them; without, the text is the whole-inbox triage as before.
function triagePrompt(cmd, mails) {
  if (mails && mails.length) {
    return [
      `Triage these ${mails.length} mails from my Gmail inbox — only these, nothing else in the inbox.`,
      '',
      ...mails.map((m, i) => `${i + 1}. ${[m.subject || '(no subject)', m.from || m.from_address, m.date, m.thread_link].filter(Boolean).join(' — ')}`),
      '',
      `\`${cmd}\` lists the whole inbox if you want context; the Gmail thread links above open each one.`,
      '',
      'Run the inbox-zero skill with scope `mail only` — the mails listed above (load it with the Skill tool',
      'first): audit every mail for staleness, report the verdicts as its numbered, linked list,',
      'then walk them one mail per round through AskUserQuestion. Nothing is sent and no task is',
      'created before I approve it in its round.',
    ].join('\n');
  }
  return [
    'Triage my Gmail inbox — the mail addressed to @erler-edv-beratung.de and to our online',
    'shops (info@macriumshop.de and the other BestofSoft shops), plus the',
    'alerts and reports our own systems send (Healthchecks, Check_MK, Gatus, cron).',
    '',
    `Run \`${cmd}\` for the list: subject, sender, date, read state, the client shortcode`,
    'the sender resolves to, and the Gmail thread link.',
    '',
    'Run the inbox-zero skill with scope `mail` on these mails (load it with the Skill tool',
    'first): audit every mail for staleness, report the verdicts as its numbered, linked list,',
    'then walk them one mail per round through AskUserQuestion. Nothing is sent and no task is',
    'created before I approve it in its round.',
  ].join('\n');
}

module.exports = {
  mailAvailable, forgetMailAvailable, mailInboxCommand, mailCacheFile,
  loadMailInbox, mailCacheAge, refreshMailInbox, mailEntry, triagePrompt,
};
