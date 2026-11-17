#!/usr/bin/env bash
# research-log hook helpers. Plain bash + coreutils + awk, so capture works anywhere Claude Code runs
# hooks (including Git Bash on Windows) even without Node. Only emit/emit_ctx may print to stdout.
#
# Speed rule: on Windows every process start costs ~50 ms and every $(...) subshell ~30 ms, so the
# per-prompt path uses builtins wherever possible. A normal sync starts 4 processes: tail, awk,
# mkdir, rmdir. Keep it that way.
#
# Globals set by hook.sh before these are used: R (.research-log dir), ST (its state dir).

RL_MAX_BATCH=${RESEARCH_LOG_MAX_BATCH:-33554432}   # bytes copied per sync at most (rest next time)

RULE_TEXT='[research-log] This project keeps a research log for a later paper. Each time one of these happens, add a line to your reply (own line, max 25 words, no tool call, no secrets):
Log stuck: <what blocks us + best guess why>
Log idea (user|claude): <suggestion or hypothesis, whoever made it>
Log decision: <choice> because <why>; rejected <alternative> (whenever you pick between options)
Log dead-end: <what was tried> failed because <why>
Log result: <what now works or was measured>
Log insight: <what we learned>
Several lines in one reply are fine. Skip purely mechanical steps.'
NUDGE_STUCK='[research-log] Several commands failed since the last log line. If we are stuck, add a "Log stuck:" line to this reply.'
NUDGE_QUIET='[research-log] No log line for a while. If something notable happened, add one "Log ...:" line to this reply.'
NO_NODE_TEXT='[research-log] Capture is on. Install Node.js to generate the journal.'

# One pass over the new transcript bytes: append complete lines to `out`, count signals, print
# "bytes fails prompts markers compactions". Works with gawk (uses RT) and other awks (a complete
# transcript line ends with "}"). Stops at a line boundary once `cap` bytes have been taken.
AWK_SYNC='
function emit(s) {
  print s >> out; n += length(s) + 1
  if (index(s, "{\"type\":\"api-request") == 1) return
  if (s ~ /"is_error":[ \t]*true/) f++
  if (s ~ /"promptSource":[ \t]*"(typed|sdk|queued|suggestion_accepted)"/) p++
  if (s ~ /"type":[ \t]*"assistant"/ && s ~ /Log (stuck|idea|decision|dead-end|result|insight)( \((user|claude|both)\))?:/) m++
  if (s ~ /"subtype":[ \t]*"compact_boundary"/) c++
}
BEGIN { gawk = ("version" in PROCINFO) }
{
  if (have) emit(prev)
  len = length($0) + 1
  if (have && rd + len > cap) { have = 0; stopped = 1; exit }
  rd += len; prev = $0; have = 1
}
END {
  if (have && !stopped && (gawk ? RT == "\n" : prev ~ /}[ \t\r]*$/)) emit(prev)
  print n + 0, f + 0, p + 0, m + 0, c + 0, stopped + 0
}'

# ---- input and project root (builtins only) ----
read_input() {
  INPUT=""
  [ -t 0 ] || IFS= read -r -d '' INPUT
  json_get session_id SESSION_ID
  json_get transcript_path TRANSCRIPT
}

# json_get <key> <var>: first string value of "key" in INPUT, with \\ unescaped.
json_get() {
  local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"" v=""
  [[ $INPUT =~ $re ]] && v=${BASH_REMATCH[1]}
  printf -v "$2" '%s' "${v//\\\\/\\}"
}

# project_root: cd into the project and set ROOT. Fails for the home dir and filesystem/drive roots
# (same guard as project-memory).
project_root() {
  local start=${CLAUDE_PROJECT_DIR:-$PWD} home=""
  cd -P ~ 2>/dev/null && home=$PWD
  cd -P "$start" 2>/dev/null || return 1
  ROOT=$PWD
  [ "$ROOT" != "$home" ] && [ "${#ROOT}" -gt 3 ]
}

# ---- small helpers ----
fsize() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log_err() {
  printf '%s\t%s\t%s\n' "$(utc)" "$1" "$2" >> "$ST/hook-errors.log" 2>/dev/null
  return 0
}

json_esc() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/}; s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

record_injection() {   # <label> <text>: bytes of every injected text, for `rlog.js cost`
  local LC_ALL=C
  printf '%s\t%s\t%s\t%s\n' "$(utc)" "${SESSION_ID:0:8}" "$1" "${#2}" >> "$ST/injected.log" 2>/dev/null
}

# emit <label> <text>: plain stdout (SessionStart). The only plain printer.
emit() {
  printf '%s\n' "$2"
  record_injection "$1" "$2"
}

# emit_ctx <label> <text>: UserPromptSubmit additionalContext JSON. The only JSON printer.
emit_ctx() {
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$(json_esc "$2")"
  record_injection "$1" "$2"
}

# lock <name>: mkdir lock; a lock older than 30 s is taken over. Returns 1 if held (caller skips;
# the next sync catches up).
lock() {
  local d="$ST/$1.lock" m
  mkdir "$d" 2>/dev/null && return 0
  m=$(mtime "$d")
  if [ -n "$m" ] && [ $(( $(date +%s) - m )) -gt 30 ]; then
    rmdir "$d" 2>/dev/null; mkdir "$d" 2>/dev/null && return 0
  fi
  return 1
}
unlock() { rmdir "$ST/$1.lock" 2>/dev/null; return 0; }

init_folder() {   # <plugin dir>
  mkdir -p "$R/journal" "$R/documentary" "$R/raw" "$ST" || return 1
  [ -f "$R/README.md" ] || cp "$1/templates/README.md" "$R/README.md"
  [ -f "$R/.gitignore" ] || cp "$1/templates/gitignore" "$R/.gitignore"
  return 0
}

off_switch() { [ -f "$R/OFF" ] || [ "${RESEARCH_LOG:-1}" = 0 ]; }

# register <transcript path>: remember it in state/sessions (newest 50 kept). Builtins unless new.
register() {
  local f="$ST/sessions" p count=0
  [ -n "$1" ] || return 0
  if [ -f "$f" ]; then
    while IFS= read -r p; do count=$((count + 1)); [ "$p" = "$1" ] && return 0; done < "$f"
  fi
  printf '%s\n' "$1" >> "$f"
  if [ $((count + 1)) -gt 50 ]; then tail -n 50 "$f" > "$f.tmp" && mv -f "$f.tmp" "$f"; fi
  return 0
}

# sync_one <transcript path>: append the transcript's new complete lines to raw/<name>.
# Sets SYNC_F SYNC_P SYNC_M SYNC_C (fails, prompts, markers, compactions in the new lines).
# Crash safety: the offset file says "<off> pending" while copying, so a killed copy is detected
# next time (newline guard) and the lines are copied again: duplicates (deduped later), never loss.
sync_one() {
  local T=$1 name M O SEEN off state sink out size attempt
  SYNC_F=0; SYNC_P=0; SYNC_M=0; SYNC_C=0
  [ -n "$T" ] && [ -f "$T" ] || return 0
  name=${T##*[/\\]}; M="$R/raw/$name"; O="$ST/$name.off"; SEEN="$ST/$name.seen"
  # Unchanged since the last complete read started: nothing to do (builtins, no process).
  # The offset file says "<off> more" when the last sync stopped at RL_MAX_BATCH; never skip then.
  if [ -f "$O" ] && [ -f "$SEEN" ] && [ "$T" -ot "$SEEN" ]; then
    off=0; state=""; read -r off state < "$O"
    [ -z "$state" ] && return 0
  fi
  lock "$name" || return 0
  for attempt in 1 2; do
    off=0; state=""
    [ -f "$O" ] && read -r off state < "$O"
    [[ $off =~ ^[0-9]+$ ]] || off=0
    if [ "$state" = pending ] && [ -s "$M" ] && [ -n "$(tail -c 1 "$M")" ]; then printf '\n' >> "$M"; fi
    sink=$M; [ -f "$ST/PAUSED" ] && sink=/dev/null
    : > "$SEEN"
    printf '%s pending\n' "$off" > "$O"
    out=$(tail -c +"$((off + 1))" "$T" 2>/dev/null | LC_ALL=C awk -v out="$sink" -v cap="$RL_MAX_BATCH" "$AWK_SYNC")
    set -- $out
    if [ "${1:-0}" -gt 0 ]; then
      if [ "$sink" = /dev/null ]; then
        printf '%s\t%s\t%s\n' "$off" "$((off + $1))" "$(utc)" >> "$M.gaps"
      else
        SYNC_F=$2; SYNC_P=$3; SYNC_M=$4; SYNC_C=$5
      fi
      if [ "${6:-0}" = 1 ]; then printf '%s more\n' "$((off + $1))" > "$O"; else printf '%s\n' "$((off + $1))" > "$O"; fi
      break
    fi
    printf '%s\n' "$off" > "$O"
    # Nothing complete was new. If the transcript is now shorter than the offset it was replaced:
    # keep the old mirror and start a new one.
    size=$(fsize "$T")
    [ "$size" -lt "$off" ] || break
    [ -f "$M" ] && mv -f "$M" "$M.$(date +%s).old"
    printf '0\n' > "$O"
  done
  unlock "$name"
}

# fold_signals <name>: add the counts of the last sync to state/<name>.sig ("fails prompts since").
# Sets FAILS PROMPTS SINCE.
fold_signals() {
  local S="$ST/$1.sig"
  FAILS=0; PROMPTS=0; SINCE=4
  [ -f "$S" ] && read -r FAILS PROMPTS SINCE < "$S"
  [[ $FAILS =~ ^[0-9]+$ ]] || FAILS=0
  [[ $PROMPTS =~ ^[0-9]+$ ]] || PROMPTS=0
  [[ $SINCE =~ ^[0-9]+$ ]] || SINCE=4
  # A compaction in the new lines (seen by any event, also mid-turn) dropped the rule from context.
  [ "$SYNC_C" -gt 0 ] && rm -f "$ST/$1.ruled"
  FAILS=$((FAILS + SYNC_F)); PROMPTS=$((PROMPTS + SYNC_P)); SINCE=$((SINCE + SYNC_P))
  if [ "$SYNC_M" -gt 0 ]; then FAILS=0; PROMPTS=0; fi
  save_signals "$1"
}
save_signals() { printf '%s %s %s\n' "$FAILS" "$PROMPTS" "$SINCE" > "$ST/$1.sig"; }
