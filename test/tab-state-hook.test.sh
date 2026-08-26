#!/usr/bin/env bash
# Tests hooks/tab-state.sh — which of the three words a given hook event writes.
#
# The Notification event is the whole reason this file exists: it covers a real
# prompt AND a "no new message for 60s" nudge, and treating them alike put "?"
# on tabs that were asking nothing.
#
# Run: bash test/tab-state-hook.test.sh
set -u
hook="$(cd "$(dirname "$0")/.." && pwd)/hooks/tab-state.sh"
export CCH_TAB_ID=11111111-2222-3333-4444-555555555555
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
file="$tmp/.cache/claude-tab-state/$CCH_TAB_ID"
pass=0; fail=0

check() { # check <what> <expected> <arg> [payload]
  local what="$1" want="$2" arg="$3" payload="${4:-{\}}"
  printf '%s' "$payload" | HOME="$tmp" CLAUDE_PROJECT_DIR="$tmp/wd" bash "$hook" "$arg"
  local got; got=$(cat "$file" 2>/dev/null)
  if [ "$got" = "$want" ]; then echo "  ok   $what: $got"; pass=$((pass+1))
  else echo "  FAIL $what: $got (expected $want)"; fail=$((fail+1)); fi
}

check "UserPromptSubmit / PreToolUse writes working"    working working
check "Stop means the turn ENDED, not idle"             ended   idle
check "the 60s nudge is not a question"                 ended   input '{"message":"Claude is waiting for your input","notificationType":"idle_prompt"}'
check "a real prompt is a question"                     input   input '{"message":"Claude needs your permission to use Bash"}'
check "back to working"                                 working working
check "a nudge mid-turn may not overwrite a live turn"  working input '{"message":"Claude is waiting for your input"}'

printf '%s' working > "$file"
HOME="$tmp" CLAUDE_PROJECT_DIR="$tmp/wd" bash "$hook" delete
if [ ! -e "$file" ]; then echo "  ok   SessionEnd deletes the file"; pass=$((pass+1))
else echo "  FAIL SessionEnd deletes the file"; fail=$((fail+1)); fi

# A session outside the extension has no tab id and must leave nothing behind.
before=$(find "$tmp/.cache/claude-tab-state" -type f | wc -l)
( unset CCH_TAB_ID; printf '{}' | HOME="$tmp" CLAUDE_PROJECT_DIR="$tmp/other" bash "$hook" working )
after=$(find "$tmp/.cache/claude-tab-state" -type f | wc -l)
if [ "$after" -eq $((before + 1)) ]; then echo "  ok   no CCH_TAB_ID still writes the cwd key, and only that"; pass=$((pass+1))
else echo "  FAIL cwd-key fallback wrote $((after - before)) files"; fail=$((fail+1)); fi

echo; echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]
