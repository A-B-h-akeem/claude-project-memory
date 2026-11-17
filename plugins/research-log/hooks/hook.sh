#!/usr/bin/env bash
# research-log hook entry point: bash hook.sh <start|prompt|stop|compact|end>
# Never blocks, never prints except through emit/emit_ctx, always exits 0.

# $0 may use / or \ (CLAUDE_PLUGIN_ROOT is a Windows path), or be a bare name when run from hooks/.
case $0 in */*|*\\*) HOOKS_DIR=${0%[/\\]*} ;; *) HOOKS_DIR=. ;; esac
HOOKS_DIR=$(cd "$HOOKS_DIR" && pwd) || exit 0
PLUGIN=${HOOKS_DIR%/*}
. "$HOOKS_DIR/lib.sh"

EVENT=${1:-}
read_input
project_root || exit 0
R="$ROOT/.research-log"; ST="$R/state"
off_switch && exit 0

if [ "$EVENT" = start ]; then
  init_folder "$PLUGIN" 2>/dev/null || exit 0
else
  [ -d "$ST" ] || exit 0                     # only start creates the folder
fi

# run_extract <may_emit>: zero-token journal extraction; capture never depends on it.
run_extract() {
  if command -v node >/dev/null 2>&1; then
    node "$PLUGIN_WIN/bin/rlog.js" extract >/dev/null
  elif [ "$1" = yes ] && [ ! -f "$ST/NO_NODE" ]; then
    : > "$ST/NO_NODE"
    emit no-node "$NO_NODE_TEXT"
  fi
}

# sync_all: catch up every transcript seen in this folder (crashed or interrupted sessions).
# Missing files are kept in the list: at SessionStart the new session's transcript does not exist
# yet. The list is capped at 50 by register.
sync_all() {
  local f="$ST/sessions" p
  [ -f "$f" ] || return 0
  while IFS= read -r p; do
    [ -n "$p" ] && [ -f "$p" ] || continue
    sync_one "$p"
    fold_signals "${p##*[/\\]}"
  done < "$f"
  return 0
}

error_notice() {
  local lines=() n seen=0
  [ -f "$ST/hook-errors.log" ] || return 0
  mapfile -t lines < "$ST/hook-errors.log"; n=${#lines[@]}
  [ -f "$ST/errors-seen" ] && read -r seen < "$ST/errors-seen"
  [[ $seen =~ ^[0-9]+$ ]] || seen=0
  if [ "$n" -gt "$seen" ]; then
    emit errors "[research-log] $((n - seen)) hook errors; see .research-log/state/hook-errors.log"
    printf '%s\n' "$n" > "$ST/errors-seen"
  fi
}

main() {
  local name=${TRANSCRIPT##*[/\\]} ctx="" source=""
  case "$1" in
    start)
      PLUGIN_WIN=$(cd "$PLUGIN" && { pwd -W 2>/dev/null || pwd; })
      printf '%s\n' "$PLUGIN_WIN" > "$ST/plugin-root"
      register "$TRANSCRIPT"
      sync_all
      run_extract yes
      error_notice
      # state/<name>.ruled exists while the rule is in this transcript's context. Hook output from
      # an earlier start survives a resume (verified), so a resume re-sends it only if it is missing.
      json_get source source
      if [ ! -f "$ST/PAUSED" ] && { [ "$source" != resume ] || [ ! -f "$ST/$name.ruled" ]; }; then
        emit rule "$RULE_TEXT"
        : > "$ST/$name.ruled"
      fi
      ;;
    prompt)
      register "$TRANSCRIPT"
      sync_one "$TRANSCRIPT"
      fold_signals "$name"
      # Rule missing (compaction dropped it, or the session started while paused): send it now.
      if [ ! -f "$ST/PAUSED" ] && [ ! -f "$ST/$name.ruled" ]; then
        ctx=$RULE_TEXT
        : > "$ST/$name.ruled"
      fi
      if [ "${RESEARCH_LOG_NUDGE:-1}" != 0 ] && [ ! -f "$ST/PAUSED" ] && [ "$SINCE" -ge 4 ]; then
        if [ "$FAILS" -ge 3 ]; then
          ctx=${ctx:+$ctx$'\n'}$NUDGE_STUCK; FAILS=0; PROMPTS=0; SINCE=0; save_signals "$name"
        elif [ "$PROMPTS" -ge 8 ]; then
          ctx=${ctx:+$ctx$'\n'}$NUDGE_QUIET; FAILS=0; PROMPTS=0; SINCE=0; save_signals "$name"
        fi
      fi
      [ -n "$ctx" ] && emit_ctx prompt "$ctx"
      ;;
    stop|compact)
      sync_one "$TRANSCRIPT"
      fold_signals "$name"
      ;;
    end)
      sync_one "$TRANSCRIPT"
      fold_signals "$name"
      PLUGIN_WIN=$(cd "$PLUGIN" && { pwd -W 2>/dev/null || pwd; })
      run_extract no
      ;;
  esac
  return 0
}

if [ -w "$ST" ]; then
  main "$EVENT" 2>>"$ST/hook-errors.log" || log_err "$EVENT" "main exited $?"
else
  main "$EVENT" 2>/dev/null
fi
exit 0
