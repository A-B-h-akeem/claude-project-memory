#!/usr/bin/env bash
# UserPromptSubmit: rank every memory entry against the user's message and inject the best few,
# so Claude starts its answer with the relevant history already in context: no search turns, and
# no entry is ever skipped. Prints nothing when nothing in memory matches.
#
# Runs on every message, so it avoids helper processes (each costs ~50 ms on Windows): the input
# is read with a builtin, and one awk process parses it, searches and prints. All entries are kept
# in a one-file corpus cache, rebuilt when a memory file changed and at least once a day (which
# also catches edits to old history files that the cheap freshness checks below don't see).

. "${BASH_SOURCE[0]%/*}/lib.sh"
defer_to_portable && exit 0
IFS= read -r -d '' INPUT
mem="${CLAUDE_PROJECT_DIR:-$PWD}/.project-memory"
[ -d "$mem/history" ] || exit 0

printf -v today '%(%Y-%m-%d)T' -1 2>/dev/null || today=$(date +%Y-%m-%d)   # bash 3.2 (macOS) lacks %()T
key="${mem//[^A-Za-z0-9]/_}"
cache="$STATE_DIR/corpus-$today-$key.tsv"

stale=""
[ -f "$cache" ] || stale=1
[ "$mem/history" -nt "$cache" ] && stale=1            # a file was added or removed
for f in "$mem"/*.md "$mem/history/SUMMARY.md" "$mem/history/$today.md"; do
  [ "$f" -nt "$cache" ] && stale=1                      # topics, plan, summary, today's log
done

awk_script="${BASH_SOURCE[0]%/*}/recall.awk"
export IN="$INPUT" TOP="${PROJECT_MEMORY_RECALL_TOP:-8}"
if [ -z "$stale" ] && [ -O "$cache" ]; then
  CACHED=1 awk -f "$awk_script" < "$cache"
elif state_dir_ok; then
  rm -f "$STATE_DIR"/corpus-*-"$key".tsv
  printf '%s\n' "$mem"/history/*.md "$mem"/*.md | CACHE="$cache.tmp" awk -f "$awk_script" && mv -f "$cache.tmp" "$cache"
else
  printf '%s\n' "$mem"/history/*.md "$mem"/*.md | awk -f "$awk_script"
fi
exit 0
