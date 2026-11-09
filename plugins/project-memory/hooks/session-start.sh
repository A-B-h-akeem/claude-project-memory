#!/usr/bin/env bash
# SessionStart: make sure this folder has a self-contained project memory, then report problems.
#
# The memory index itself is loaded by Claude Code through `@../.project-memory/MEMORY.md` in .claude/CLAUDE.md,
# so any Claude Code picks it up, plugin or not. This hook only prints the index on the session
# where it adds that import (CLAUDE.md was already read by then), plus warnings when something is off.

. "$(dirname "$0")/lib.sh"
read_input
here=$(project_root) || exit 0
mem="$here/.project-memory"
src="$(dirname "$0")"
templates="$src/templates"                                   # portable copy
[ -d "$templates" ] || templates="$src/../skills/project-memory/templates"   # plugin

# This folder runs its own copy of the hooks (portable mode). The plugin's copy only keeps that
# copy current and checks it wasn't altered, then leaves the rest to it so nothing runs twice.
if defer_to_portable; then
  bin="$here/.project-memory/bin"
  theirs=$(head -n 1 "$bin/VERSION" 2>/dev/null)
  mine=$(plugin_version "$src")
  if [ -n "$mine" ] && version_gt "$mine" "${theirs:-0}"; then
    install_portable_files "$src" "$bin" "$mine" &&
      echo "[project-memory] Updated this folder's portable memory scripts (.project-memory/bin) from v$theirs to v$mine."
  elif [ "$mine" = "$theirs" ]; then
    changed=""
    for f in $PORTABLE_FILES; do cmp -s "$src/$f" "$bin/$f" || changed="$changed $f"; done
    [ -n "$changed" ] &&
      echo "[project-memory] Warning: .project-memory/bin/ differs from the plugin's v$mine copy ($changed ). These scripts run on every message; tell the user to review them, or to restore them by turning portable mode off and on."
  fi
  exit 0
fi

created=""
if [ ! -f "$mem/MEMORY.md" ]; then
  mkdir -p "$mem" 2>/dev/null && cp "$templates/MEMORY.md" "$mem/MEMORY.md" 2>/dev/null || exit 0
  created=1
fi
mkdir -p "$mem/history" 2>/dev/null
for f in RULES.md history/SUMMARY.md; do
  [ -f "$mem/$f" ] || cp "$templates/$f" "$mem/$f" 2>/dev/null
done

# Make the folder load its own memory in any Claude Code. Memory sits outside .claude/ because
# Claude Code asks permission for every edit under .claude/, which would stall the checkpoints.
linked=1
if ! grep -qs '^@.*\.project-memory/MEMORY\.md' "$here/.claude/CLAUDE.md" "$here/CLAUDE.md"; then
  mkdir -p "$here/.claude" 2>/dev/null
  if [ -f "$here/.claude/CLAUDE.md" ]; then
    printf '\n@../.project-memory/MEMORY.md\n' >> "$here/.claude/CLAUDE.md"
  else
    printf '# Project memory (maintained in .project-memory/)\n@../.project-memory/MEMORY.md\n' > "$here/.claude/CLAUDE.md"
  fi
  linked=""
fi

# Start counting prompts for checkpoints from here (kept across /compact and resume).
[ -f "$(state_file)" ] || set_checkpoint

if [ -n "$created" ]; then
  echo "[project-memory] Created .project-memory/ for this folder. Fill in Overview and Current work once you know the project (don't delay the user's task)."
fi
if [ -z "$linked" ]; then
  echo "[project-memory] Linked it in .claude/CLAUDE.md, so future sessions load it automatically. Current index:"
  echo
  head -c "$INDEX_MAX" "$mem/MEMORY.md"
fi
[ -n "$created" ] && exit 0

size=$(file_size "$mem/MEMORY.md")
[ "$size" -gt "$INDEX_BUDGET" ] &&
  echo "[project-memory] MEMORY.md is $size bytes, over the $INDEX_BUDGET budget: move detail into topic files."

# Where the plan stands: the first unfinished step, in one line.
if [ -f "$mem/PLAN.md" ]; then
  total=$(grep -c '^- \[[ x]\]' "$mem/PLAN.md")
  done_steps=$(grep -c '^- \[x\]' "$mem/PLAN.md")
  current=$(grep -m 1 '^- \[ \]' "$mem/PLAN.md" | sed 's/^- \[ \] *//' | cut -c1-100)
  if [ -n "$current" ]; then
    echo "[project-memory] PLAN.md: $done_steps/$total steps done; current: $current"
  elif [ "$total" -gt 0 ]; then
    echo "[project-memory] PLAN.md: all $total steps done; archive it per RULES.md if the plan is finished."
  fi
fi

# Paths mentioned in memory (in backticks) that no longer exist. Only MEMORY.md and topic files are
# checked: RULES.md holds examples, PLAN.md names files still to be created, and history/ is
# supposed to mention old paths.
stale=$(ls "$mem"/*.md 2>/dev/null | grep -v -e '/RULES\.md$' -e '/PLAN\.md$' | tr '\n' '\0' |
  xargs -0 grep -oh '`[^` ]*`' 2>/dev/null | tr -d '`' | sed 's/:[0-9][0-9]*$//; s#^\./##' | sort -u |
  while IFS= read -r p; do
    case "$p" in *://*|*'*'*|'$'*|-*|'~'*|'<'*|'') continue ;; esac
    case "$p" in
      */*|*.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.py|*.ipynb|*.json|*.md|*.yml|*.yaml|*.toml|*.ini|*.cfg|*.env|\
      *.sh|*.ps1|*.bat|*.go|*.rs|*.java|*.kt|*.c|*.h|*.cpp|*.hpp|*.cs|*.rb|*.php|*.sql|*.css|*.scss|*.html|\
      *.vue|*.svelte|*.lock|*.txt|*.csv|*.ino|*.xml) ;;
      *) continue ;;
    esac
    case "$p" in
      /*|[A-Za-z]:*) [ -e "$p" ] || echo "$p" ;;
      *) [ -e "$here/$p" ] || [ -e "$mem/$p" ] || echo "$p" ;;
    esac
  done | head -n 8 | tr '\n' ' ')
[ -n "$stale" ] && echo "[project-memory] Paths in memory not found (update if moved or deleted; fine if planned): $stale"

# Secrets that slipped into memory: it is shared with whoever gets the folder. Only file:line is
# printed, never the match, so the secret doesn't land in Claude's context too.
secrets=$(cd "$mem" && grep -rnIE --include='*.md' --exclude='RULES.md' \
  -e 'AKIA[0-9A-Z]{16}' -e 'sk-[A-Za-z0-9_-]{20,}' -e '(sk|rk)_live_[0-9A-Za-z]{16,}' -e 'gh[pousr]_[A-Za-z0-9]{30,}' \
  -e 'github_pat_[A-Za-z0-9_]{30,}' -e 'xox[abprs]-[A-Za-z0-9-]{10,}' -e 'AIza[0-9A-Za-z_-]{35}' -e '-----BEGIN [A-Z ]*PRIVATE KEY' \
  -e '(password|passwd|secret|api[_-]?key|access[_-]?token)["'\'']?[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9/+_.-]*[0-9][A-Za-z0-9/+_.-]{7,}' \
  . 2>/dev/null | cut -d: -f1,2 | sed 's#^\./##' | head -n 5 | tr '\n' ' ')
[ -n "$secrets" ] &&
  echo "[project-memory] Possible secret in memory at: $secrets. Tell the user, and replace the value with where it lives (e.g. \"in .env, DATABASE_URL\")."

# Finished months that have day files but no line in history/SUMMARY.md yet.
this_month=$(date +%Y-%m)
unsummarized=$(ls "$mem/history" 2>/dev/null | sed -n 's/^\([0-9]\{4\}-[0-9]\{2\}\)-[0-9]\{2\}\.md$/\1/p' | sort -u |
  while IFS= read -r m; do
    [ "$m" = "$this_month" ] && continue
    grep -q "^- $m" "$mem/history/SUMMARY.md" 2>/dev/null || echo "$m"
  done | tr '\n' ' ')
[ -n "$unsummarized" ] &&
  echo "[project-memory] history/SUMMARY.md has no line for: $unsummarized(see RULES.md, History)."

# Work that happened outside memory: commits since it was last updated, and uncommitted changes.
if git -C "$here" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # List the history folder rather than expanding every file into one command line: a year of
  # day files is longer than Windows allows for a command line.
  since=$(mtime "$(ls -t "$mem"/*.md 2>/dev/null | head -n 1)")
  newest_day=$(ls -t "$mem/history" 2>/dev/null | grep '\.md$' | head -n 1)
  if [ -n "$newest_day" ]; then
    t=$(mtime "$mem/history/$newest_day")
    [ -n "$t" ] && [ "${t:-0}" -gt "${since:-0}" ] && since=$t
  fi
  if [ -n "$since" ]; then
    commits=$(git -C "$here" log -n 50 --no-merges --format='%ct %h %s' 2>/dev/null |
      awk -v t="$since" '$1 > t { $1 = ""; print substr($0, 2) }')
    if [ -n "$commits" ]; then
      count=$(printf '%s\n' "$commits" | wc -l | tr -d ' ')
      [ "$count" -ge 50 ] && count="50+"
      echo "[project-memory] $count commit(s) since memory was last updated; check Current work is still right:"
      printf '%s\n' "$commits" | head -n 5 | cut -c1-100
    fi
  fi
  dirty=$(git -C "$here" status --porcelain 2>/dev/null | grep -v -e '\.claude/' -e '\.project-memory/' | wc -l | tr -d ' ')
  [ "$dirty" -gt 0 ] && echo "[project-memory] $dirty uncommitted change(s) in the working tree."
fi
exit 0
