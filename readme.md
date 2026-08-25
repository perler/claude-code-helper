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
    ]
  }
}
```

Merge these into the existing `hooks` block if one is already there — don't replace it.

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
