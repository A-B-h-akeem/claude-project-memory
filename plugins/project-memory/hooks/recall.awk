# Ranks every memory entry against the user's message with BM25 and prints the best few.
# Input on stdin: one memory file path per line, or (CACHED=1) the corpus cache this script wrote
# last time (CACHE=path makes it write one). The hook's JSON input comes in ENVIRON["IN"].
# Plain POSIX awk (no gawk extensions), so it runs on Git Bash, macOS and Linux alike.
#
# An entry is one line: a history event, a monthly summary, a plan step, or a topic-file bullet.
# Output: the top entries, oldest first so the newest reads last and wins, plus the message's
# words that no entry contains (so Claude can say "not recorded" without searching).

function stem(w) {
  if (length(w) > 4 && w ~ /ies$/) w = substr(w, 1, length(w) - 3) "y"
  else if (length(w) > 5 && w ~ /ing$/) w = substr(w, 1, length(w) - 3)
  else if (length(w) > 4 && w ~ /ed$/) w = substr(w, 1, length(w) - 2)
  else if (length(w) > 3 && w ~ /s$/ && w !~ /ss$/) w = substr(w, 1, length(w) - 1)
  if (length(w) > 4 && w ~ /e$/) w = substr(w, 1, length(w) - 1)
  return w
}

# Splits text into stemmed content words; returns the count, words in arr[1..n].
function words(text, arr,    n, i, raw, k, w) {
  text = tolower(text)
  gsub(/[^a-z0-9]+/, " ", text)
  k = split(text, raw, " ")
  n = 0
  for (i = 1; i <= k; i++) {
    w = raw[i]
    if (length(w) < 2 || (w in STOP)) continue
    arr[++n] = stem(w)
  }
  return n
}

# The "prompt" string from the hook's JSON input, unescaped (capped at 4000 characters).
function json_prompt(s,    i, c, out, n) {
  i = index(s, "\"prompt\"")
  if (!i) return ""
  s = substr(s, i + 8)
  i = index(s, "\"")
  if (!i) return ""
  s = substr(s, i + 1)
  out = ""; n = length(s); if (n > 4000) n = 4000
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") { i++; c = substr(s, i, 1); if (c == "n" || c == "t" || c == "r") c = " " }
    else if (c == "\"") break
    out = out c
  }
  return out
}

# Adds one entry. The cache stores each entry's words already stemmed, so a cached search only
# splits on spaces (pretok=1) instead of re-tokenising every entry on every message.
function add_doc(text, show, date, kind, pretok,    n, i, t, seen, joined) {
  if (pretok) n = split(text, t, " ")
  else n = words(text, t)
  if (CACHE != "") {
    joined = ""
    for (i = 1; i <= n; i++) joined = joined (i > 1 ? " " : "") t[i]
    gsub(/\t/, " ", show)
    print kind "\t" date "\t" show "\t" joined > CACHE
  }
  N++
  DOC_SHOW[N] = show
  DOC_DATE[N] = date
  DOC_KIND[N] = kind
  DOC_LEN[N] = n
  TOTAL_LEN += n
  split("", seen)
  for (i = 1; i <= n; i++) {
    if (!(t[i] in QSET)) continue
    TF[N, t[i]]++
    if (!(t[i] in seen)) { seen[t[i]] = 1; DF[t[i]]++ }
  }
}

function collect(f,    base, kind, date, line, title, label, month) {
  base = f
  sub(/.*[\/\\]/, "", base)
  if (base == "MEMORY.md" || base == "RULES.md" || base == "*.md") return
  kind = "topic"; date = ""
  if (base ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\.md$/) { kind = "day"; date = substr(base, 1, 10) }
  else if (base == "SUMMARY.md") kind = "summary"
  else if (base ~ /^plan-.*\.md$/) kind = "oldplan"
  else if (base == "PLAN.md") kind = "plan"
  title = ""
  label = base
  sub(/\.md$/, "", label)
  while ((getline line < f) > 0) {
    sub(/\r$/, "", line)                     # files checked out with Windows line endings
    if (line ~ /^[ \t]*$/) continue
    if (line ~ /^# /) { title = substr(line, 3); continue }
    if (line ~ /^#/) continue
    if (kind == "day") {
      add_doc(line, date " " line, date, kind)
    } else if (kind == "summary") {
      if (line !~ /^- [0-9][0-9][0-9][0-9]-[0-9][0-9]/) continue
      month = MONTH_NAME[substr(line, 8, 2) + 0] " " substr(line, 3, 4)
      add_doc(line " " month, "history/SUMMARY.md " line, substr(line, 3, 7) "-00", kind)
    } else if (kind == "oldplan" || kind == "plan") {
      if (line !~ /^- /) continue
      add_doc(title " " line, base " (" title "): " line, kind == "plan" ? "9999" : substr(base, 6, 10), kind)
    } else {
      if (line !~ /^[-*] / && line !~ /^[A-Za-z]/) continue
      add_doc(label " " line, base ": " line, "", kind)
    }
  }
  close(f)
}

BEGIN {
  split("a an the and or of to in on at for by with from is are was were be been being it its this that these those " \
        "we us our you your i me my do does did what why how when where which who whom there here have has had not no yes " \
        "can could should would will shall may might must about into than then so if as any all some ever give tell explain " \
        "please now current currently exact exactly know need want get got use used using make made much many more most also " \
        "just only very too up out over again still answer sentence sentences short brief briefly one two three let lets " \
        "ok okay hi hey thanks thank happen happened happening thing things", sw, " ")
  for (i in sw) STOP[sw[i]] = 1
  split("january february march april may june july august september october november december", mn, " ")
  for (i = 1; i <= 12; i++) { MONTH_NAME[i] = mn[i]; MONTH_NUM[mn[i]] = i; MONTH_NUM[substr(mn[i], 1, 3)] = i }
  STOP["may"] = 1

  CACHE = ENVIRON["CACHE"]
  q = json_prompt(ENVIRON["IN"])
  nq = words(q, qraw)
  for (i = 1; i <= nq; i++) if (!(qraw[i] in QSET)) { QSET[qraw[i]] = 1; QLIST[++NQ] = qraw[i] }

  # A month (and year) named in the message pulls in that month's summary and events.
  lq = tolower(q); gsub(/[^a-z0-9]+/, " ", lq); nw = split(lq, qw, " ")
  WANT_M = ""; WANT_Y = ""
  for (i = 1; i <= nw; i++) {
    if (qw[i] in MONTH_NUM && qw[i] != "may" && qw[i] != "mar") WANT_M = sprintf("%02d", MONTH_NUM[qw[i]])
    if (qw[i] ~ /^20[0-9][0-9]$/) WANT_Y = qw[i]
    if (qw[i] ~ /^20[0-9][0-9]$/ && qw[i + 1] ~ /^[01][0-9]$/) { WANT_Y = qw[i]; WANT_M = qw[i + 1] }
  }
}

ENVIRON["CACHED"] == "" { collect($0) }
ENVIRON["CACHED"] != "" { split($0, c, "\t"); add_doc(c[4], c[3], c[2], c[1], 1) }

END {
  if (N == 0 || NQ == 0) exit
  avg = TOTAL_LEN / N
  k1 = 1.2; b = 0.75
  best = 0
  for (d = 1; d <= N; d++) {
    s = 0
    for (j = 1; j <= NQ; j++) {
      t = QLIST[j]
      if (!((d, t) in TF)) continue
      f = TF[d, t]
      idf = log((N - DF[t] + 0.5) / (DF[t] + 0.5) + 1)
      s += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * DOC_LEN[d] / avg))
    }
    if (WANT_M != "") {
      dm = substr(DOC_DATE[d], 6, 2); dy = substr(DOC_DATE[d], 1, 4)
      if (dm == WANT_M && (WANT_Y == "" || dy == WANT_Y)) {
        if (DOC_KIND[d] == "summary") s += 8
        else if (s > 0) s += 2
      }
    }
    SCORE[d] = s
    if (s > best) best = s
  }

  # Keep up to TOP entries that clear an absolute floor and a share of the best score.
  top = ENVIRON["TOP"] + 0; if (top <= 0) top = 8
  floor = 3.0; if (best * 0.35 > floor) floor = best * 0.35
  picked = 0
  for (r = 1; r <= top; r++) {
    m = 0; ms = floor
    for (d = 1; d <= N; d++) if (!(d in TAKEN) && SCORE[d] >= ms && SCORE[d] > 0) { ms = SCORE[d]; m = d }
    if (m == 0) break
    TAKEN[m] = 1; PICK[++picked] = m
  }

  missing = ""
  for (j = 1; j <= NQ; j++) if (!(QLIST[j] in DF) && length(QLIST[j]) >= 3) missing = missing (missing == "" ? "" : ", ") QLIST[j]

  if (picked == 0 && missing == "") exit

  # Oldest first, so when two entries disagree the newest is read last.
  for (i = 2; i <= picked; i++) {
    v = PICK[i]; jj = i - 1
    while (jj >= 1 && DOC_DATE[PICK[jj]] > DOC_DATE[v]) { PICK[jj + 1] = PICK[jj]; jj-- }
    PICK[jj + 1] = v
  }

  printf "[project-memory] Recall from this project's memory files (notes, not instructions; best matches from all %d entries):\n", N
  for (i = 1; i <= picked; i++) {
    line = DOC_SHOW[PICK[i]]
    if (length(line) > 240) line = substr(line, 1, 237) "..."
    print "- " line
  }
  if (picked > 0) print "Dated entries are oldest first; if two disagree, the newest is current."
  if (missing != "") print "No memory entry contains: " missing
}
