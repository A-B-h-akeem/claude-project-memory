#!/usr/bin/env bash
# Stop: every $EVERY user prompts (default 2), or right after a git commit, have Claude bring the
# project memory and history up to date and give the user a short "done so far / plan from here"
# summary. Costs one short extra turn when it fires.

. "$(dirname "$0")/lib.sh"
defer_to_portable && exit 0              # the folder runs its own copy of this hook
read_input
json_true stop_hook_active && exit 0          # this stop is the end of a checkpoint turn
here=$(project_root) || exit 0
mem="$here/.project-memory"
[ -d "$mem" ] && [ -n "$SESSION_ID" ] && [ -f "$TRANSCRIPT" ] || exit 0

state=$(state_file)
if [ ! -f "$state" ]; then
  state_dir_ok && echo 0 > "$state"
fi

last=$(tr -d ' \n' < "$state")
size=$(file_size "$TRANSCRIPT")
[ "$size" -gt "${last:-0}" ] || exit 0

# Only the part of the transcript written since the last checkpoint is scanned.
segment_count() {
  tail -c +"$((last + 1))" "$TRANSCRIPT" | grep -c "$1"
}
# User messages: typed (interactive), sdk (claude -p / SDK), queued (typed while Claude was busy),
# suggestion_accepted. "system" sources are Claude Code's own messages and don't count.
prompts=$(segment_count '"promptSource":"\(typed\|sdk\|queued\|suggestion_accepted\)"')
[ "$prompts" -ge 1 ] || exit 0
commits=$(segment_count '"command":"[^"]*git commit')

if [ "$prompts" -ge "$EVERY" ] || [ "$commits" -ge 1 ]; then
  set_checkpoint
  cat <<'EOF'
{"decision":"block","reason":"[project-memory] Checkpoint. Follow the Checkpoint section of .project-memory/RULES.md: (1) add one history line per event since the last checkpoint to today's history/YYYY-MM-DD.md; (2) update Current work, PLAN.md step status if there is a plan, and any new decision, gotcha or command; (3) end with this summary for the user, and nothing else:\n\n**Checkpoint**\n- Done so far: <what's finished overall, briefly>\n- Plan from here: <next 1-3 steps; PLAN.md step N/M if there is a plan>\n- Open: <questions or blockers, or 'none'>\n\nOnly if nothing at all happened since the last checkpoint (just questions answered, no progress or decisions), skip all of this and end your turn with no message."}
EOF
fi
exit 0
