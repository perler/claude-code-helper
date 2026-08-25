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
# TWO keys are written, because a session can be identified two ways:
#
#   <uuid>          CCH_TAB_ID, set by the extension in the environment of a
#                   session it launched. Exact: one tab, one id, no ambiguity.
#   cwd-<sha1>      the session's working directory. Works for sessions that
#                   were already running before CCH_TAB_ID existed (their
#                   environment is fixed and can never gain it), so a reload
#                   lights those tabs up too. The extension only trusts this
#                   key when exactly one terminal sits in that directory —
#                   two sessions in one folder are indistinguishable here.
#
# A session with neither (no CCH_TAB_ID and no resolvable cwd) leaves nothing
# behind; the tab simply stays undecorated. Never guess which tab is which.

set -u

state="${1:-}"

dir="$HOME/.cache/claude-tab-state"
mkdir -p "$dir" 2>/dev/null || exit 0

keys=()

if [[ "${CCH_TAB_ID:-}" =~ ^[0-9a-f-]{36}$ ]]; then
  keys+=("$CCH_TAB_ID")
fi

# CLAUDE_PROJECT_DIR is set by Claude Code for hook processes; PWD is the
# fallback, since hooks run in the session's own directory.
cwd="${CLAUDE_PROJECT_DIR:-$PWD}"
if [ -n "$cwd" ] && command -v sha1sum >/dev/null 2>&1; then
  keys+=("cwd-$(printf '%s' "$cwd" | sha1sum | cut -d' ' -f1)")
fi

[ ${#keys[@]} -gt 0 ] || exit 0

# The Notification event covers two unrelated things: a real permission prompt,
# and a "no new message for 60s" nudge (notificationType idle_prompt). The nudge
# also fires MID-TURN, during a long tool call — so writing `input` on every
# notification marks a busy session as waiting for you, and it stays that way
# until the turn ends. Observed live: a working session showed "?" for hours.
# So an idle nudge may only assert `input` when the turn is not running.
if [ "$state" = "input" ]; then
  payload=$(timeout 1 cat 2>/dev/null || true)
  [ -n "${CCH_TAB_TRACE:-}" ] && printf '%s\n' "$(date +%H:%M:%S) state=$state id=${CCH_TAB_ID:-none} payload=$payload" >> "$HOME/.cache/claude-tab-state.trace" 2>/dev/null
  case "$payload" in
    *"waiting for your input"*|*idle_prompt*)
      current=$(cat "$dir/${keys[0]}" 2>/dev/null || true)
      [ "$current" = "working" ] && exit 0
      ;;
  esac
fi

[ -n "${CCH_TAB_TRACE:-}" ] && printf '%s\n' "$(date +%H:%M:%S) WRITE state=$state keys=${keys[*]}" >> "$HOME/.cache/claude-tab-state.trace" 2>/dev/null

for key in "${keys[@]}"; do
  file="$dir/$key"
  if [ "$state" = "delete" ]; then
    rm -f "$file" 2>/dev/null
    continue
  fi
  case "$state" in
    working|input|idle) printf '%s' "$state" > "$file" 2>/dev/null ;;
  esac
done

exit 0
