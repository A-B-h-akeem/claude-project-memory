# Manual checks (T27, T28)

## 2026-11-17, Claude Code 2.1.325, Windows 11, headless (`claude -p --plugin-dir`), Haiku
- T27 coexistence: `project-memory` 3.1.0 (user scope) ran in the same sessions and blocked a Stop for its checkpoint; research-log never blocked and added no turn. Its Stop hook printed nothing. Mirror byte-identical to the transcript afterwards, no hook errors.
- End to end: 2-turn session (failed command, resume, `note:` line, two rejected tool calls) produced the expected journal; `/research-log status` and `/research-log:research-log build` worked; the Haiku chapter passed `check-chapter` on the first try.
- Cost: 928 bytes injected (rule text twice: start + resume), 0 markers, ~232 tokens for the session. Haiku wrote no `Log` markers on its own.
- Hook latency: sync with new lines ~340 ms, no-op ~175 ms; 228 MB transcript caught up in 8 syncs, slowest 915 ms.

## Still to do
- T28 on a real 20-prompt interactive session with the main model: `rlog.js cost` should show under 500 tokens.
- Interactive session: confirm whether SessionStart fires with `source: compact` after `/compact` (headless did not). Either way the prompt hook covers it.
