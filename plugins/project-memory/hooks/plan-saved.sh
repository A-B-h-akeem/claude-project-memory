#!/usr/bin/env bash
# PostToolUse on ExitPlanMode: a plan was just made in plan mode, so have Claude save it to PLAN.md
# before starting work, so the plan survives into new chats and handoffs.

. "$(dirname "$0")/lib.sh"
defer_to_portable && exit 0              # the folder runs its own copy of this hook
read_input
here=$(project_root) || exit 0
[ -d "$here/.project-memory" ] || exit 0

cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"[project-memory] A plan was just made. Before starting the work, save it to .project-memory/PLAN.md in the format from the Plans section of .project-memory/RULES.md (archive any previous PLAN.md first), point Current work at it, and add a decision line to today's history file."}}
EOF
exit 0
