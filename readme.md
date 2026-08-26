# Claude Code Helper

Sidebar with two views:

1. **Favourites** — bookmark directories, start/resume Claude Code sessions with one click. Multi-session resume opens a picker.
2. **Terminals** — list of open VS Code terminals with inline focus and right-click actions (reveal CWD, rename, split, kill).

Replaces the standalone `claude-favourites` and `terminal-tree` extensions.

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

## Tab state decorations

A badge and colour on a Claude session's terminal editor tab — `*` (dimmed) while it's working,
`?` (warning colour) while it's waiting for your answer, nothing while idle. No change to the
tab's title or icon.

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

**This needs hooks registered in `~/.claude/settings.json` — the extension does not add them.**
Add:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash /home/work/projects/claude-code-helper/hooks/tab-state.sh working" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "bash /home/work/projects/claude-code-helper/hooks/tab-state.sh input" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash /home/work/projects/claude-code-helper/hooks/tab-state.sh idle" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "bash /home/work/projects/claude-code-helper/hooks/tab-state.sh delete" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "bash /home/work/projects/claude-code-helper/hooks/tab-state.sh working" }] }
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
