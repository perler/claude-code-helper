#!/usr/bin/env bash
# Claude Code Helper — records this session's tab state so the VS Code
# file-decoration provider in extension.js can show it on the terminal's
# editor tab (a badge + colour, no title/icon change).
#
# Usage: tab-state.sh working|input|idle|delete
#
# See readme.md "Tab state decorations" for the settings.json hook block and
# the event -> argument mapping.
#
# CCH_TAB_ID is set by the extension in a Claude session's environment when it
# launches that session (via the terminal's `env` option, or threaded into the
# tmux/dtach master's spawn — see extension.js). A session started any other
# way (a plain shell, a headless bridge run without the extension) has no
# CCH_TAB_ID; this script is then a silent no-op by design — never guess which
# tab a session belongs to.

set -u

state="${1:-}"

[[ "${CCH_TAB_ID:-}" =~ ^[0-9a-f-]{36}$ ]] || exit 0

dir="$HOME/.cache/claude-tab-state"
file="$dir/$CCH_TAB_ID"

mkdir -p "$dir" 2>/dev/null || exit 0

if [ "$state" = "delete" ]; then
  rm -f "$file" 2>/dev/null
  exit 0
fi

case "$state" in
  working|input|idle) printf '%s' "$state" > "$file" 2>/dev/null ;;
esac

exit 0
