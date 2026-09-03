# Claude Code Helper

A sidebar for running Claude Code out of VS Code / code-server. Six panels:

1. **New Task** — a text box that starts a session. It works out where the work belongs
   (a client, a project, or a fresh scratch folder), names the session and opens it.
2. **Favourites** — bookmarked directories; start or resume a session in one click.
   Resuming a folder with several sessions opens a picker.
3. **Running Sessions** — the open terminals, with focus and right-click actions
   (reveal CWD, rename, split, kill).
4. **Agent Sessions** — sessions the Asana→Claude bridge spawned, live or ended, with
   attach, resume and kill.
5. **Recent Sessions** — every Claude session on the machine, newest first, searchable,
   with resume.
6. **Bookmarks** — URLs, opened in the browser or in a tab inside the editor.

Replaces the standalone `claude-favourites` and `terminal-tree` extensions.

**Two of those are only there when the machine has the pieces they need.** The Agent
Sessions panel appears when the Asana CLI (`claudeHelper.asanaCommand`) is installed or
the bridge's index/history file exists. The queue buttons under the New Task box, and
the "Open Asana Task" context-menu items, appear when that CLI is installed; the ✉️ Mail
button needs `claudeHelper.mailInboxCommand`. On a
workstation without either, the Agent Sessions panel is gone, the New Task box keeps
everything but its queue row, and nothing is spawned in the background. Everything else — favourites, terminals, recent sessions, bookmarks,
Go to Folder, the tab badges — needs nothing beyond Claude Code itself.

## Installing on another workstation

```bash
git clone https://github.com/perler/claude-code-helper.git
cd claude-code-helper
npm install -g @vscode/vsce      # once, if vsce is not already there
vsce package
code --install-extension claude-code-helper-*.vsix --force
```

Reload the window afterwards. Then set the paths that are specific to that machine —
all of them optional, all under `claudeHelper` in settings:

| Setting | What to point it at |
|---|---|
| `folderSearchRoots` | the directories **Go to Folder…** should scan |
| `scratchDir` | where a nameless new session gets its folder |
| `clientsDir` / `projectsDir` | the roots the New Task box offers as destinations |

For the terminal-tab badges, add the hooks from "Tab state decorations" below. If you
want the Asana panels there too, that needs the `asana` CLI and the bridge, which are
not part of this repo.

**Go to Folder… (`Ctrl+Alt+P`)** — Quick Open indexes files only, so there is no built-in way to
jump to a folder by name. This command scans `claudeHelper.folderSearchRoots` for directories and
fuzzy-matches on the folder name. Enter runs the action set in `claudeHelper.folderSearchAction`
(reveal it in the Explorer of the current window, by default — if the folder is outside every open
root you get the choice to add it to the workspace or open a new window); the other actions —
open folder, terminal here, start Claude here, add to favourites — sit as buttons on the
highlighted row. Uses `fd` (or
`fdfind`) when installed and falls back to `find`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `claudeHelper.claudeCommand` | `claude` | Claude CLI command / path |
| `claudeHelper.skipPermissions` | `true` | Append `--dangerously-skip-permissions` |
| `claudeHelper.cliFlags` | `` | Extra flags appended to every invocation |
| `claudeHelper.defaultTerminalMode` | `internal` | `ask` / `internal` / `external` |
| `claudeHelper.externalTerminalCommand` | `` | Template with `{cwd}` `{cmd}` |
| `claudeHelper.reuseTerminal` | `false` | Reuse terminal with same name |
| `claudeHelper.confirmRemove` | `true` | Confirm before removing a favourite |
| `claudeHelper.confirmKillTerminal` | `true` | Confirm before killing a terminal |
| `claudeHelper.showTerminalsWithoutCwd` | `true` | Show terminals with no detected cwd |
| `claudeHelper.shortenPaths` | `true` | Replace `$HOME` with `~` in displayed paths |
| `claudeHelper.folderSearchRoots` | `~/clients ~/projects ~/hosting ~/tasks` | Roots scanned by Go to Folder… |
| `claudeHelper.folderSearchDepth` | `3` | Levels below each root to descend |
| `claudeHelper.folderSearchExcludes` | `node_modules .git venv .venv dist build __pycache__` | Directory names skipped |
| `claudeHelper.folderSearchAction` | `reveal` | What Enter does in Go to Folder… |
| `claudeHelper.tabStateDecorations` | `true` | Show working/waiting/idle badges on Claude terminal tabs (needs the hook below) |
| `claudeHelper.tabStateTrace` | `false` | Log each tab's computed badge to `~/.cache/claude-tab-state.exttrace` |
| `claudeHelper.sessionsMaxAgeDays` | `7` | Recent Sessions only lists sessions touched in the last N days |
| `claudeHelper.sessionsMaxItems` | `100` | Cap on the Recent Sessions list |
| `claudeHelper.scratchDir` | `~/tasks` | Base directory for a new, unnamed session |
| `claudeHelper.autoRenameScratchSessions` | `true` | Rename a finished scratch folder to a slug of Claude's own session title |
| `claudeHelper.useTmux` | `true` | Run sessions inside tmux, so they survive a reload and are reachable from Claude Mobile |
| `claudeHelper.useDtach` | `true` | With `useTmux` off, run them inside dtach instead (this is what the tab badges need) |
| `claudeHelper.dtachSocketDir` | `~/.claude/dtach` | Where the per-session dtach sockets live |
| `claudeHelper.bookmarksFile` | `` | Bookmarks JSON; empty means `~/.config/cc-bookmarks.json` |
| `claudeHelper.clientsDir` | `~/clients` | Root of client folders the New Task box can route to |
| `claudeHelper.projectsDir` | `~/projects` | Root of project folders the New Task box can route to |
| `claudeHelper.titleModel` | `claude-haiku-4-5-…` | Model that names a New Task session and picks its destination |
| `claudeHelper.apiKeyFile` | `~/.env` | File read for `ANTHROPIC_API_KEY`; routing goes through the API (~1s) instead of the CLI (~9s) |
| `claudeHelper.asanaCommand` | `~/tools/asana/asana` | Asana CLI. **Absent means the Asana panels and buttons are hidden.** |
| `claudeHelper.agentIndexPath` | `~/.claude/agent-sessions.json` | Index the Asana→Claude bridge writes; feeds Agent Sessions |
| `claudeHelper.agentTmuxSocket` | `claude` | tmux socket (`-L`) the bridge's sessions use |
| `claudeHelper.mailLookupCommand` | (site-specific) | Resolves an `email <subject>` New Task entry to the actual mail |
| `claudeHelper.mailInboxCommand` | (site-specific) | Lists the inbox mail addressed to us; **absent means no ✉️ Mail button** |

## The buttons under the New Task box

📅 Today, ⏳ Input and 📁 walk an Asana queue and are only there when the Asana CLI is
installed. ✉️ Mail opens the inbox and is only there when
`claudeHelper.mailInboxCommand` points at a script that runs. The number on a button is
what is in that queue, or that inbox, right now.

The counts are cached on disk (`~/.cache/claude-code-helper/queue-counts.json`, and
`mail-inbox.json` for the mail — which caches the whole list, so the number on the button
and the rows in the picker come from the same read and cannot disagree) so the
buttons paint instantly when a window opens, then refreshed behind that. While the panel
is visible they refresh once a minute, and stop when it is not — the view is created with
`retainContextWhenHidden`, so a sidebar left open on this container fires no visibility
event and would otherwise sit on the count it read when the window loaded. The refresh
button in the panel header forces a fetch, ignoring the two-minute cache window.

### ✉️ Mail

The mail Gmail holds for `@erler-edv-beratung.de` — everything in the inbox whose
To/Cc/Delivered-To names that domain, newest first, unread marked with a dot. Two ways
out of the picker:

- **One mail** goes through the same routing as anything typed into the box: the sender
  decides the client, and the session opens in that client's folder with the thread to
  reply to. It is the `email <subject>` entry without the typing — and without the second
  IMAP round trip, because the picker already holds the message.
- **Triage all N** starts one session that reads every one of them and hands back a
  numbered table with a proposed action per mail, then waits. Nothing is sent and no task
  is created before you approve its row.

## Tab state decorations

A badge and colour on a Claude session's terminal editor tab. No change to the tab's title or icon.

| Badge | Means |
|---|---|
| `*` dimmed | a turn is running — including one parked in a `run_in_background` shell |
| `!` warning | the turn finished and **you have not looked yet** |
| `?` warning | the session is **asking** something — a permission prompt, a real question |
| none | idle, or a finished turn you have already read |

`!` is cleared by looking: focusing that tab drops it, and the tab you are sitting on never grows
one while the window has focus. The mark is not persisted — after a window reload every finished
turn counts as unread again, which is the safe direction.

The three words matter because Claude Code's `Notification` event covers two unrelated things: a
real prompt, and a "no new message for 60 s" nudge that fires after *every* turn. Treating both as
`?` put question marks on tabs that were asking nothing (reported 2026-08-26), so the nudge — and
the `Stop` hook — write `ended` instead, and only a genuine notification writes `input`.

The extension generates a `CCH_TAB_ID` uuid per launched session and puts it in that session's
environment. A hook script, `hooks/tab-state.sh` in this repo, reads it back and writes one word
to `~/.cache/claude-tab-state/$CCH_TAB_ID`; the extension watches that directory and renders the
file's contents as the tab's decoration. A session started outside this extension has no
`CCH_TAB_ID`, so the hook is a silent no-op for it — no crash, no stray file.

**The session's own live state outranks those files.** The hooks are event-driven: each writes what
was true at the instant an event fired, and nothing at all happens between events. A session that
ends a turn, collects the 60-second "Claude is waiting for your input" nudge and then goes back to
work — or sits in a long `run_in_background` shell making no tool calls at all — keeps the `input`
that nudge wrote, because the `PreToolUse` self-heal below has nothing to fire on. Seen live on
2026-08-26: a session waiting on a background job showed `?` for minutes with nothing being asked.

So the extension also reads `~/.claude/sessions/<pid>.json`, the CLI's own per-session state file
(pid, cwd, procStart and a live `status`: `idle` / `busy` / `shell` / …) — the same thing
`claude agents --json` reports from, minus the ~470ms subprocess, cheap enough to read on the
decoration path. `procStart` is checked against field 22 of `/proc/<pid>/stat` so a recycled pid
can't inherit a dead session's badge, and the pid maps to a tab through `CCH_TAB_ID` in
`/proc/<pid>/environ`.

The two sources each know half of it: the session file knows whether the session is *doing*
something, the hook file knows *why* it stopped. `idle` is the only status that means idle —
`busy`, `shell` and anything a later version adds render `*`. A live `working` wins over whatever
the hook last wrote, and a live `idle` clears a stale `working` but **never** an `input`, or every
tab waiting on an answer would silently lose its `?`. (0.35.0 polled `claude agents --json` into an
async cache and let `idle` win outright — which stripped the `?` off every waiting tab, and left a
tab painted before the first answer landed stuck on its stale badge. Both are why this reads files
instead.) If the directory or its format ever changes, every read returns nothing and the hook files
run the badges alone, as they did before.

Set `"claudeHelper.tabStateTrace": true` to log what every tab computed to
`~/.cache/claude-tab-state.exttrace` — key, live state, file state and the badge — for diagnosing a
badge that looks wrong. Read live, so it needs no window reload.

**A resumed session's tab.** A terminal that ATTACHES to an already-running session gets no
`CCH_TAB_ID` — the session is already carrying the one it was born with. Neither the registration
nor `/proc/<pid>/environ` finds anything for such a terminal, and the `cwd-` fallback is refused
whenever more than one session lives in the folder, so a resumed session used to be permanently
undecorated (and worse: the launcher registered a freshly-minted id nothing ever writes to, which
*outranks* every route that would have worked). It is identified the long way round instead: the
terminal's `dtach -a <session-id>.sock` child gives the session id, the CLI's session file turns
that into the live pid, and that pid's environ has the real tab id.

**Tests.** `node test/tab-state.test.js` drives the real provider out of `extension.js` against
real state files and real processes (each fixture session is two actual processes carrying a
`CCH_TAB_ID`, so `/proc/<pid>/environ` and the `procStart` check are exercised, not stubbed); only
the VS Code API is faked. `bash test/tab-state-hook.test.sh` covers which word each hook event
writes. Run both after touching either side — every regression this feature has had was a wrong
badge, not a crash, and a wrong badge is invisible to a syntax check.

**A window that has not been reloaded still runs the extension it loaded.** These words are shared
between the hook and the extension, so an old window renders nothing for a word it does not know —
after upgrading, reload EVERY code-server window, not just the front one.

**This needs hooks registered in `~/.claude/settings.json` — the extension does not add them.**
Add the following, replacing `<repo>` with the path you cloned this repository to:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash <repo>/hooks/tab-state.sh working" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "bash <repo>/hooks/tab-state.sh input" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash <repo>/hooks/tab-state.sh idle" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "bash <repo>/hooks/tab-state.sh delete" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "bash <repo>/hooks/tab-state.sh working" }] }
    ]
  }
}
```

Merge these into the existing `hooks` block if one is already there — don't replace it.

**Why `PreToolUse` is in that list.** `Notification` is the only event that reports "waiting for
you", but nothing reports "the user answered". Approving a permission prompt fires no hook at all,
so without a second source the tab would sit on `?` for the rest of the turn even though Claude
went straight back to work — which is exactly what happened in practice. A tool call is
unambiguous evidence that the session is working, so `PreToolUse` re-asserts `working` and the
badge self-heals within one tool call, whatever left it stale. Cost is one short shell script per
tool call.

Set `CCH_TAB_TRACE=1` in a session's environment to have the hook append every invocation, with
the notification payload, to `~/.cache/claude-tab-state.trace` — the fastest way to see which
event actually fired when a badge looks wrong.

**Sessions that predate `CCH_TAB_ID`.** A Claude session that was already running when this
feature was installed can never gain the variable — its environment was fixed when it started. For
those, the hook also writes a second key, `cwd-<sha1 of the session's directory>`, and the
extension falls back to it: terminal's shell pid -> `/proc/<pid>/cwd` -> same hash. It only trusts
that key when **exactly one** terminal in the window sits in that directory; with two sessions open
on the same folder the key cannot say which tab is which, so neither gets a badge. Freshly launched
sessions always use the exact uuid and are never affected by that.

**Survives a window reload.** A dtach-mode (or plain internal-terminal-mode) terminal is the same
live OS process before and after a code-server window reload — VS Code just reconnects its pty,
it never re-runs the launch code — so its shell's original environment, `CCH_TAB_ID` included, is
still there to read back from `/proc/<pid>/environ`. The extension uses that as a fallback whenever
a terminal wasn't launched (or registered) in the current window session, so badges keep working
after a reload without needing anything re-launched.

**Known limitation: tmux-mode sessions never get a badge.** With `claudeHelper.useTmux` on
(the default), the terminal tab only ever runs `tmux attach` — a different OS process from the
tmux server that actually holds Claude — so there's no live process whose environment could ever
be read back for it, reload or not. Turn `useTmux` off (dtach takes over, also on by default) if
you want the badges.
