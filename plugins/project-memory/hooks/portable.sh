#!/usr/bin/env bash
# Portable mode: give a project folder its own copy of the memory hooks, so any Claude Code that
# opens (and trusts) the folder gets recall, checkpoints and plan saving without the plugin.
#
#   bash portable.sh enable  [project-dir]   copy the hooks into .project-memory/bin and register them
#   bash portable.sh disable [project-dir]   remove them
#   bash portable.sh status  [project-dir]
#
# It never rewrites an existing .claude/settings.json: when that file already exists, it prints the
# hooks block and exits with status 3, and Claude merges it (or removes it) by hand.

src="$(cd "$(dirname "$0")" && pwd)"
. "$src/lib.sh"
action="${1:-status}"
root="${2:-${CLAUDE_PROJECT_DIR:-$PWD}}"
root=$(cd "$root" 2>/dev/null && pwd) || { echo "No such folder: $2"; exit 1; }
mem="$root/.project-memory"
bin="$mem/bin"
settings="$root/.claude/settings.json"
version=$(plugin_version "$src")

hook() {  # one hook entry; $1 = script name. Skips quietly if the script was deleted.
  printf '{ "type": "command", "command": "f=\\"$CLAUDE_PROJECT_DIR/.project-memory/bin/%s\\"; [ ! -f \\"$f\\" ] || PROJECT_MEMORY_PORTABLE=1 bash \\"$f\\"" }' "$1"
}
hooks_block() {
  cat <<EOF
  "hooks": {
    "SessionStart": [ { "hooks": [ $(hook session-start.sh) ] } ],
    "UserPromptSubmit": [ { "hooks": [ $(hook recall.sh), $(hook prompt-check.sh) ] } ],
    "Stop": [ { "hooks": [ $(hook checkpoint.sh) ] } ],
    "PostToolUse": [ { "matcher": "ExitPlanMode", "hooks": [ $(hook plan-saved.sh) ] } ]
  }
EOF
}
generated() {
  printf '{\n%s\n}\n' "$(hooks_block)"
}
registered() {
  grep -q '\.project-memory/bin/recall\.sh' "$settings" 2>/dev/null
}

case "$action" in
  enable)
    [ -f "$mem/MEMORY.md" ] || { echo "This folder has no project memory yet (.project-memory/MEMORY.md). Start a Claude Code session here with the plugin first."; exit 1; }
    install_portable_files "$src" "$bin" "$version" || { echo "Could not write $bin"; exit 1; }
    echo "Copied the memory hooks (v$version) into .project-memory/bin/."
    if registered; then
      echo "They are already registered in .claude/settings.json. Portable mode is on."
    elif [ ! -f "$settings" ]; then
      mkdir -p "$root/.claude" && generated > "$settings" && echo "Registered them in a new .claude/settings.json. Portable mode is on."
    else
      echo "MERGE NEEDED: .claude/settings.json already exists, so it was not changed."
      echo "Add these hooks to it, keeping every existing setting and hook (append to any event that already has hooks):"
      hooks_block
      exit 3
    fi
    echo "Commit .project-memory/ and .claude/settings.json so the folder carries them. Whoever opens it is asked to trust the folder before the hooks run."
    ;;
  disable)
    rm -rf "$bin" && echo "Removed .project-memory/bin/."
    if [ -f "$settings" ] && [ "$(cat "$settings")" = "$(generated)" ]; then
      rm -f "$settings" && rmdir "$root/.claude" 2>/dev/null
      echo "Removed .claude/settings.json (it held only these hooks). Portable mode is off."
    elif registered; then
      echo "REMOVE NEEDED: delete every hook whose command mentions .project-memory/bin/ from .claude/settings.json, keeping everything else."
      exit 3
    else
      echo "Portable mode is off."
    fi
    ;;
  status)
    if [ -f "$bin/VERSION" ] && registered; then
      echo "Portable mode is on (scripts v$(head -n 1 "$bin/VERSION"); plugin v$version)."
    elif [ -f "$bin/VERSION" ]; then
      echo "Scripts are in .project-memory/bin/ but not registered in .claude/settings.json, so they don't run."
    elif registered; then
      echo ".claude/settings.json registers portable hooks, but .project-memory/bin/ is missing, so they fail. Turn portable mode on again or remove those hooks."
    else
      echo "Portable mode is off."
    fi
    ;;
  *) echo "Usage: portable.sh enable|disable|status [project-dir]"; exit 1 ;;
esac
exit 0
