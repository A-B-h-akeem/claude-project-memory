#!/usr/bin/env bash
# UserPromptSubmit: when the user's message is about planning, remind Claude to save the plan to
# PLAN.md. Prints nothing for every other message, so it costs nothing there.

. "$(dirname "$0")/lib.sh"
defer_to_portable && exit 0              # the folder runs its own copy of this hook
read_input
here=$(project_root) || exit 0
[ -d "$here/.project-memory" ] || exit 0

# The prompt can contain escaped quotes, so match \" and other escapes inside the string.
prompt=$(printf '%s' "$INPUT" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\(\([^"\\]\|\\.\)*\)".*/\1/p' | head -n 1)
if printf '%s' "$prompt" | grep -qiE '(^|[^/\\[:alnum:]_.-])(plan(s|ning)?|roadmap|milestones?)($|[^/\\[:alnum:]_.-])|step[- ]by[- ]step|steps to (build|make|do)'; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[project-memory] If this message leads to a plan (steps to build or do something), save it to .project-memory/PLAN.md in the format from the Plans section of .project-memory/RULES.md, in this same turn, and point Current work at it. If PLAN.md already exists, update it instead."}}
EOF
fi
exit 0
