---
name: research-log
description: Research log controls (status, stats, index, import, build, verify, export, pause, resume). Only when the user types /research-log.
disable-model-invocation: true
argument-hint: status | stats | index | import [--dry-run] | build | verify | export [--with-raw] | pause | resume | cost
---
Run from the project root. R is the contents of `.research-log/state/plugin-root` (one line). Argument: $ARGUMENTS (default `status`).

status, stats, index, import, verify, export, pause, resume, cost: run `node "<R>/bin/rlog.js" <argument>` (pass any extra words, such as `--dry-run`, unchanged) and show its output. Do nothing else.

build:
1. Run `node "<R>/bin/rlog.js" build-list`. No lines: say the documentary is up to date and stop.
2. For each line start one Agent with model haiku, at most 5 at a time. Its prompt is `<R>/templates/chapter-prompt.md` with {DIGEST} and {CHAPTER} replaced by the two tab-separated paths. Do not read the digests yourself.
3. Run `node "<R>/bin/rlog.js" check-chapter "<chapter path>"` on each, using the full second path of its build-list line. On failure, rerun that agent once with the failure text added; if it fails again, leave it and report it.
4. Run `node "<R>/bin/rlog.js" stitch`. Tell the user the path of DOCUMENTARY.md, how many chapters were written, and any that failed.
