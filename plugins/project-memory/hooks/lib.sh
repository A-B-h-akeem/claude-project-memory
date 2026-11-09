#!/usr/bin/env bash
# Shared helpers for the project-memory hooks. Plain bash + coreutils only (no jq/python/node),
# so it runs anywhere Claude Code runs hooks, including Git Bash on Windows.
#
# These scripts run in two places: from the plugin, and as a folder's own copy in
# .project-memory/bin/ (portable mode), which is started with PROJECT_MEMORY_PORTABLE=1.

INDEX_BUDGET=${PROJECT_MEMORY_INDEX_BUDGET:-4000}   # bytes of MEMORY.md before we ask Claude to condense
INDEX_MAX=8000                                      # hard cap on what gets loaded
EVERY=${PROJECT_MEMORY_EVERY:-2}                    # user prompts between memory checkpoints
# Per-user, owner-only: on a shared machine another user must not be able to plant a search cache
# (it is injected into Claude's context) or reset checkpoint state.
STATE_DIR="${TMPDIR:-/tmp}/project-memory-${UID:-user}"
# Everything a portable copy needs; templates/ goes alongside.
PORTABLE_FILES="lib.sh session-start.sh recall.sh recall.awk checkpoint.sh prompt-check.sh plan-saved.sh"

# Hook input arrives as one JSON object on stdin.
read_input() {
  INPUT=""
  [ -t 0 ] || INPUT=$(cat)
  SESSION_ID=$(json_get session_id)
  TRANSCRIPT=$(json_get transcript_path)
}

json_get() {
  local v
  v=$(printf '%s' "$INPUT" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1)
  printf '%s' "${v//\\\\/\\}"
}

json_true() {
  printf '%s' "$INPUT" | grep -q "\"$1\"[[:space:]]*:[[:space:]]*true"
}

# The project folder, or failure for the home directory and filesystem/drive roots.
project_root() {
  local here home
  here=$(cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null && pwd -P) || return 1
  home=$(cd ~ 2>/dev/null && pwd -P)
  [ "$here" != "$home" ] && [ "${#here}" -gt 3 ] || return 1
  printf '%s' "$here"
}

mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

file_size() {
  if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi
}

# Creates the state directory owner-only, and refuses one that someone else owns.
state_dir_ok() {
  [ -d "$STATE_DIR" ] || (umask 077 && mkdir -p "$STATE_DIR") 2>/dev/null || return 1
  [ -O "$STATE_DIR" ]
}

# The state file holds the transcript offset of the last checkpoint; its mtime marks when that was.
state_file() {
  printf '%s/%s' "$STATE_DIR" "$SESSION_ID"
}

set_checkpoint() {
  [ -n "$SESSION_ID" ] || return 0
  state_dir_ok && file_size "$TRANSCRIPT" > "$(state_file)"
}

# True when this is the plugin's copy and the folder runs its own portable copy, which then does
# the work instead, so no hook runs twice. Builtins only: recall.sh calls this on every message.
defer_to_portable() {
  [ -n "$PROJECT_MEMORY_PORTABLE" ] && return 1
  local root="${CLAUDE_PROJECT_DIR:-$PWD}" settings=""
  [ -f "$root/.project-memory/bin/VERSION" ] && [ -f "$root/.claude/settings.json" ] || return 1
  IFS= read -r -d '' settings < "$root/.claude/settings.json"
  [[ "$settings" == *".project-memory/bin/recall.sh"* ]]
}

# version_gt 3.1.0 3.0.9 -> true. Numeric per part, so 3.10 > 3.9.
version_gt() {
  local IFS=. i
  local -a a=($1) b=($2)
  for i in 0 1 2; do
    (( ${a[i]:-0} > ${b[i]:-0} )) && return 0
    (( ${a[i]:-0} < ${b[i]:-0} )) && return 1
  done
  return 1
}

plugin_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/../.claude-plugin/plugin.json" 2>/dev/null | head -n 1
}

# Copies the hook scripts and templates from a plugin hooks dir into a folder's .project-memory/bin.
install_portable_files() {
  local src="$1" bin="$2" version="$3" f
  mkdir -p "$bin/templates/history" || return 1
  for f in $PORTABLE_FILES; do cp "$src/$f" "$bin/$f" || return 1; done
  cp "$src/../skills/project-memory/templates/MEMORY.md" "$src/../skills/project-memory/templates/RULES.md" "$bin/templates/" &&
    cp "$src/../skills/project-memory/templates/history/SUMMARY.md" "$bin/templates/history/" || return 1
  printf '%s\n' "$version" > "$bin/VERSION"
  printf '%s\n' '# Keep these scripts LF-only, or bash cannot run them after a Windows checkout.' '* text eol=lf' > "$bin/.gitattributes"
  cat > "$bin/README.txt" <<EOF
project-memory portable hooks, version $version

These scripts let any Claude Code that opens this folder use its project memory, with or without
the project-memory plugin. They are registered in .claude/settings.json and run when you trust
the folder. Review them before trusting a folder from someone you don't know.

What each one does (none of them sends anything anywhere):
  session-start.sh  repairs missing memory files and prints warnings (paths that no longer
                    exist, commits since the last memory update, possible secrets in memory)
  recall.sh/.awk    on each message, ranks the memory entries against it and adds the best few
  checkpoint.sh     every 2 messages, asks Claude to update memory and summarise progress
  prompt-check.sh   when a message mentions a plan, reminds Claude to save it to PLAN.md
  plan-saved.sh     after plan mode, reminds Claude to save the plan to PLAN.md
  lib.sh            shared helpers

They read .project-memory/ and the session transcript, and write only a search cache and
checkpoint counters under your temp folder (project-memory-<your user id>).

To turn portable mode off: delete this folder and remove the hooks that mention
.project-memory/bin from .claude/settings.json.
EOF
}
