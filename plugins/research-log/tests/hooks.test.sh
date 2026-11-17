#!/usr/bin/env bash
# Hook tests T1–T16, T25, T26 (build spec §16). Each case builds a temp project whose path contains a
# space, pipes hook JSON shaped like the real payloads (SCHEMA.md) into hook.sh, and checks files/stdout.

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(cd "$HERE/.." && pwd)
HOOK="$PLUGIN/hooks/hook.sh"
PASS=0; FAIL=0
TMP=$(mktemp -d "${TMPDIR:-/tmp}/rl-hooks.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
jsonpath() { winpath "$1" | sed 's/\\/\\\\/g'; }

# new_proj <id>: sets P (project) and T (transcript) with spaces in both paths.
new_proj() {
  ID=$1; P="$TMP/proj $1"; T="$TMP/claude projects/$1/sess-$1.jsonl"
  mkdir -p "$P" "$(dirname "$T")"; : > "$T"
}
# hook <event> [extra json fields] [transcript]: runs hook.sh; stdout in OUT, exit code in RC.
hook() {
  local t=${3:-$T} name arg
  name=$(basename "$t" .jsonl)
  case $1 in
    SessionStart) arg=start ;; UserPromptSubmit) arg=prompt ;; Stop) arg=stop ;;
    PreCompact) arg=compact ;; SessionEnd) arg=end ;; *) arg=$1 ;;
  esac
  OUT=$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"x","hook_event_name":"%s"%s}' \
        "$name" "$(jsonpath "$t")" "$1" "${2:-}" | CLAUDE_PROJECT_DIR="$P" bash "$HOOK" "$arg")
  RC=$?
}
n=0
line_prompt() { n=$((n + 1)); printf '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"%s"},"uuid":"p-%s-%s","timestamp":"2026-11-16T17:%02d:00.000Z","promptSource":"typed","sessionId":"s1"}\n' "$1" "$ID" "$n" "$((n % 60))"; }
line_fail()   { n=$((n + 1)); printf '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"Exit code 1\\nboom","is_error":true}]},"uuid":"f-%s-%s","timestamp":"2026-11-16T17:%02d:00.000Z","sessionId":"s1"}\n' "$ID" "$n" "$((n % 60))"; }
line_mark()   { n=$((n + 1)); printf '{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok\\nLog stuck: %s"}]},"uuid":"m-%s-%s","timestamp":"2026-11-16T17:%02d:00.000Z","sessionId":"s1"}\n' "$1" "$ID" "$n" "$((n % 60))"; }
add() { "$@" >> "$T"; }
raw() { printf '%s' "$P/.research-log/raw/$(basename "$T")"; }
same() { cmp -s "$1" "$2"; }
empty() { [ -z "$OUT" ] && [ "$RC" -eq 0 ]; }

echo "hooks"

# T1
new_proj t1; add line_prompt "hello"
hook SessionStart ',"source":"startup"'
R1="$P/.research-log"
check "T1 folder created" test -d "$R1/journal" -a -d "$R1/documentary" -a -d "$R1/raw" -a -d "$R1/state" -a -f "$R1/README.md" -a -f "$R1/.gitignore"
check "T1 rule printed once" test "$(printf '%s\n' "$OUT" | grep -c 'This project keeps a research log')" = 1
rule_bytes=$(bash -c '. "$1"; LC_ALL=C; printf "%s" "${#RULE_TEXT}"' _ "$PLUGIN/hooks/lib.sh")
check "T1 rule <= 600 bytes ($rule_bytes)" test "$rule_bytes" -le 600
check "T1 injection recorded" grep -q "rule	$rule_bytes" "$R1/state/injected.log"
check "T1 plugin root recorded" test -s "$R1/state/plugin-root"

# T2
new_proj t2; HOME_SAVE=$HOME; export HOME="$TMP/home"; mkdir -p "$HOME"
OUT=$(printf '{"session_id":"x","transcript_path":"%s"}' "$(jsonpath "$T")" | CLAUDE_PROJECT_DIR="$HOME" bash "$HOOK" start); RC=$?
check "T2 home dir: nothing" eval 'empty && test ! -e "$HOME/.research-log"'
OUT=$(printf '{"session_id":"x"}' | CLAUDE_PROJECT_DIR="/" bash "$HOOK" start); RC=$?
check "T2 filesystem root: nothing" empty
export HOME=$HOME_SAVE
hook SessionStart; mkdir -p "$P/.research-log"; : > "$P/.research-log/OFF"; rm -rf "$P/.research-log/raw"
hook SessionStart
check "T2 OFF file: nothing" eval 'empty && test ! -d "$P/.research-log/raw"'
new_proj t2b; OUT=$(printf '{"session_id":"x","transcript_path":"%s"}' "$(jsonpath "$T")" | RESEARCH_LOG=0 CLAUDE_PROJECT_DIR="$P" bash "$HOOK" start); RC=$?
check "T2 RESEARCH_LOG=0: nothing" eval 'empty && test ! -e "$P/.research-log"'

# T3 / T8
new_proj t3; hook SessionStart
for i in 1 2 3 4 5; do add line_prompt "msg $i"; add line_fail; hook Stop; done
check "T3 mirror byte-identical after 5 syncs (T8: spaces in paths)" same "$T" "$(raw)"

# T4
new_proj t4; hook SessionStart; add line_prompt "complete"
printf '{"partial":' >> "$T"; hook Stop
check "T4 partial line not copied" eval '! grep -q partial "$(raw)"'
printf '1}\n' >> "$T"; hook Stop
check "T4 copied once complete" same "$T" "$(raw)"

# T5
# Simulates a hook killed halfway through an append: half a line in the mirror, offset "pending".
new_proj t5; hook SessionStart; add line_prompt "one"; hook Stop
off=$(wc -c < "$T"); add line_prompt "two"; last=$(tail -n 1 "$T")
printf '%s' "${last:0:30}" >> "$(raw)"; printf '%s pending\n' "$off" > "$P/.research-log/state/$(basename "$T").off"
hook Stop
check "T5 newline guard keeps the re-copied line intact" grep -qxF "$last" "$(raw)"
check "T5 earlier lines untouched" grep -qxF "$(head -n 1 "$T")" "$(raw)"

# T6
new_proj t6; hook SessionStart; add line_prompt "alpha"; add line_prompt "beta"; hook Stop
rm -f "$P/.research-log/state/$(basename "$T").off"; hook Stop
check "T6 kill before offset save duplicates raw lines" test "$(wc -l < "$(raw)")" -gt "$(wc -l < "$T")"
hook SessionEnd
j=$(cat "$P"/.research-log/journal/*.md 2>/dev/null)
check "T6 journal has no duplicates" test "$(printf '%s\n' "$j" | grep -c '| prompt |')" = 2

# T7
new_proj t7; hook SessionStart; add line_prompt "a long first transcript"; add line_prompt "more"; hook Stop
line_prompt "new" > "$T"; hook Stop
check "T7 old mirror rotated" eval 'ls "$P/.research-log/raw/" | grep -q "\.old$"'
check "T7 new mirror complete" same "$T" "$(raw)"

# T9
new_proj t9; hook SessionStart; add line_prompt "x"; add line_fail
for ev in Stop PreCompact SessionEnd; do
  e=$(case $ev in Stop) echo stop;; PreCompact) echo compact;; SessionEnd) echo end;; esac)
  OUT=$(printf '{"session_id":"x","transcript_path":"%s"}' "$(jsonpath "$T")" | CLAUDE_PROJECT_DIR="$P" bash "$HOOK" "$e"); RC=$?
  check "T9 $e prints nothing" empty
done

# T10
new_proj t10; hook SessionStart
: > "$P/.research-log/state/missing.jsonl.ruled"      # this session already has the rule
for e in prompt stop end; do
  OUT=$(printf '{"session_id":"x","transcript_path":"C:\\\\nope\\\\missing.jsonl"}' | CLAUDE_PROJECT_DIR="$P" bash "$HOOK" "$e"); RC=$?
  check "T10 missing transcript: $e silent" empty
done
rm -rf "$P/.research-log/state"; : > "$P/.research-log/state"
for e in prompt stop end; do
  OUT=$(printf '{"session_id":"x","transcript_path":"%s"}' "$(jsonpath "$T")" | CLAUDE_PROJECT_DIR="$P" bash "$HOOK" "$e" 2>/dev/null); RC=$?
  check "T10 broken state dir: $e silent, exit 0" empty
done

# T11
new_proj t11; hook SessionStart; add line_prompt "first session"; hook Stop
TA=$T; add line_prompt "written after the last sync (crash)"
T="$TMP/claude projects/t11/sess-t11b.jsonl"; : > "$T"; hook SessionStart
check "T11 earlier session completed at next start" same "$TA" "$P/.research-log/raw/$(basename "$TA")"
T=$TA

# T12
new_proj t12; hook SessionStart
add line_fail; add line_fail; add line_fail; add line_prompt "q1"; hook UserPromptSubmit
first=$OUT
check "T12 stuck nudge sent" eval 'printf "%s" "$first" | grep -q "Several commands failed"'
check "T12 nudge is valid JSON" node -e 'JSON.parse(process.argv[1])' "$first"
nb=$(node -e 'process.stdout.write(String(Buffer.byteLength(JSON.parse(process.argv[1]).hookSpecificOutput.additionalContext)))' "$first")
check "T12 nudge <= 160 bytes ($nb)" test "$nb" -le 160
add line_fail; add line_fail; add line_fail; add line_prompt "q2"; hook UserPromptSubmit
check "T12 not repeated within 4 prompts" test -z "$OUT"

# T13
new_proj t13; hook SessionStart
add line_fail; add line_fail; add line_fail; add line_mark "the proxy"; add line_prompt "q"; hook UserPromptSubmit
check "T13 marker suppresses the nudge" test -z "$OUT"

# T14
new_proj t14; hook SessionStart
for i in 1 2 3 4 5 6 7 8; do add line_prompt "p$i"; done; hook UserPromptSubmit
check "T14 quiet nudge after 8 prompts" eval 'printf "%s" "$OUT" | grep -q "No log line for a while"'
new_proj t14b; hook SessionStart
for i in 1 2 3 4 5 6 7 8; do add line_prompt "p$i"; done
OUT=$(printf '{"session_id":"x","transcript_path":"%s"}' "$(jsonpath "$T")" | RESEARCH_LOG_NUDGE=0 CLAUDE_PROJECT_DIR="$P" bash "$HOOK" prompt)
check "T14 RESEARCH_LOG_NUDGE=0 silences it" test -z "$OUT"

# T15
new_proj t15; hook SessionStart; add line_prompt "before pause"; hook Stop
node "$PLUGIN/bin/rlog.js" pause --root "$(winpath "$P")" >/dev/null
add line_prompt "secret plans"; hook Stop; add line_prompt "more secret"; hook Stop
node "$PLUGIN/bin/rlog.js" resume --root "$(winpath "$P")" >/dev/null
add line_prompt "after resume"; hook Stop; hook SessionEnd
check "T15 paused lines absent from raw" eval '! grep -q secret "$(raw)" && grep -q "after resume" "$(raw)"'
check "T15 gap range recorded" test -s "$(raw).gaps"
check "T15 journal shows the gap" eval 'grep -q "| paused |" "$P"/.research-log/journal/*.md'

# T16
new_proj t16; hook SessionStart; TA=$T; TB="$TMP/claude projects/t16/sess-t16b.jsonl"; : > "$TB"
for i in 1 2 3; do T=$TA; add line_prompt "a$i"; hook Stop; T=$TB; add line_prompt "b$i"; hook Stop; done
check "T16 two transcripts, two mirrors" eval 'same "$TA" "$P/.research-log/raw/$(basename "$TA")" && same "$TB" "$P/.research-log/raw/$(basename "$TB")"'
T=$TA; mkdir "$P/.research-log/state/$(basename "$T").lock"; add line_prompt "while locked"; hook Stop
check "T16 held lock: sync skipped" eval '! grep -q "while locked" "$(raw)"'
rmdir "$P/.research-log/state/$(basename "$T").lock"; hook Stop
check "T16 next sync catches up" same "$T" "$(raw)"

# No Node on PATH: capture still works, one notice
new_proj nonode; add line_prompt "hi"
OUT=$(printf '{"session_id":"x","transcript_path":"%s"}' "$(jsonpath "$T")" | PATH="/usr/bin:/bin" CLAUDE_PROJECT_DIR="$P" bash "$HOOK" start)
check "no Node: capture works and notice shown" eval 'same "$T" "$(raw)" && printf "%s" "$OUT" | grep -q "Install Node.js"'
OUT=$(printf '{"session_id":"x","transcript_path":"%s"}' "$(jsonpath "$T")" | PATH="/usr/bin:/bin" CLAUDE_PROJECT_DIR="$P" bash "$HOOK" start)
check "no Node: notice only once" eval '! printf "%s" "$OUT" | grep -q "Install Node.js"'

# Compaction: rule re-sent once on the next prompt (V2 fallback)
new_proj cmp; hook SessionStart; add line_prompt "x"
printf '{"parentUuid":null,"isSidechain":false,"type":"system","subtype":"compact_boundary","content":"Conversation compacted","uuid":"c1","timestamp":"2026-11-16T18:00:00.000Z","sessionId":"s1"}\n' >> "$T"
hook UserPromptSubmit
check "V2 fallback: rule re-sent after compaction" eval 'printf "%s" "$OUT" | grep -q "This project keeps a research log"'
hook UserPromptSubmit
check "V2 fallback: only once" test -z "$OUT"
boundary() { printf '{"parentUuid":null,"isSidechain":false,"type":"system","subtype":"compact_boundary","content":"Conversation compacted","uuid":"c-%s","timestamp":"2026-11-16T18:00:00.000Z","sessionId":"s1"}\n' "$1"; }
add boundary 2; hook Stop
check "compaction seen at Stop prints nothing" empty
add line_prompt "after a mid-turn compaction"; hook UserPromptSubmit
check "compaction seen at Stop: rule sent on the next prompt" eval 'printf "%s" "$OUT" | grep -q "This project keeps a research log"'

# Resume: the rule is still in context, so it is not sent again
new_proj rsm; add line_prompt "x"; hook SessionStart ',"source":"startup"'
hook SessionStart ',"source":"resume"'
check "resume: rule not re-sent" test -z "$OUT"
add boundary 3; hook SessionEnd
hook SessionStart ',"source":"resume"'
check "resume after compaction: rule sent" eval 'printf "%s" "$OUT" | grep -q "This project keeps a research log"'
new_proj rsm2; add line_prompt "x"; hook SessionStart ',"source":"resume"'
check "resume of a session never given the rule: rule sent" eval 'printf "%s" "$OUT" | grep -q "This project keeps a research log"'
new_proj psd; add line_prompt "x"; mkdir -p "$P/.research-log/state"; : > "$P/.research-log/state/PAUSED"
hook SessionStart ',"source":"startup"'
check "started while paused: no rule" test -z "$OUT"
rm -f "$P/.research-log/state/PAUSED"; add line_prompt "y"; hook UserPromptSubmit
check "after resume command: rule sent on the next prompt" eval 'printf "%s" "$OUT" | grep -q "This project keeps a research log"'

# T25
# Counted with od: Git Bash grep reports a false CR match on LF-only files.
crlf=""
for f in "$PLUGIN"/hooks/*.sh "$PLUGIN"/hooks/*.json "$PLUGIN"/bin/rlog.js "$PLUGIN"/skills/*/SKILL.md "$PLUGIN"/tests/*.sh; do
  [ "$(od -An -c "$f" | grep -c '\\r')" -gt 0 ] && crlf+=" $(basename "$f")"
done
check "T25 no CRLF in scripts${crlf:+ ($crlf)}" test -z "$crlf"

# T26
if [ "${RL_SKIP_BIG:-0}" != 1 ]; then
  new_proj big; hook SessionStart
  pad=$(head -c 900 /dev/zero | tr '\0' 'x')
  line=$(line_prompt "$pad")
  yes "$line" | head -n 220000 >> "$T"
  mb=$(( $(wc -c < "$T") / 1048576 ))
  worst=0; rounds=0
  while ! same "$T" "$(raw)" && [ $rounds -lt 20 ]; do
    s=$(date +%s%N); hook Stop; e=$(( ($(date +%s%N) - s) / 1000000 )); rounds=$((rounds + 1))
    [ $e -gt $worst ] && worst=$e
  done
  check "T26 ${mb} MB caught up in $rounds syncs, slowest ${worst} ms (< 10000)" eval 'same "$T" "$(raw)" && [ $worst -lt 10000 ]'
  add line_prompt "small"; s=$(date +%s%N); hook Stop; e=$(( ($(date +%s%N) - s) / 1000000 ))
  check "T26 later small sync ${e} ms (< 500)" test $e -lt 500
fi

echo "hooks: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
