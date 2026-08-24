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
