# research-log

A Claude Code plugin that keeps a documentary of how a project was built: what was asked, what failed, where you got stuck, which ideas came from you and which from Claude, what was decided, and what was abandoned. It is source material for a later research paper or write-up. It does not write the paper.

It costs almost nothing in tokens: it never adds a turn or a tool call. Measured overhead is about 120 tokens per session start, plus about 30 tokens for each one-line `Log …:` marker Claude adds to a reply it was writing anyway.

## How it works

1. **Capture (bash hooks, 0 tokens).** Each session transcript is copied, byte for byte, into `.research-log/raw/` inside the project. Claude Code deletes old transcripts after about 30 days; this copy stays.
2. **Journal (Node script, 0 tokens).** A timeline is extracted from the copy: prompts, failed commands, rejected tool calls, edits, commits, interruptions, compactions, your `note:` lines and Claude's `Log …:` markers. One file per session in `.research-log/journal/`, plus `TIMELINE.md`.
3. **Documentary (on demand).** `/research-log build` has Haiku subagents write one chapter per session from a compressed digest (goal, what happened, stuck points, ideas and who proposed them, decisions, dead ends, results, open questions). Every quote is checked against the record.

4. **Index and stats (Node script, 0 tokens).** `INDEX.md` lists every decision, stuck point, idea, dead end, result, insight and note across all sessions, with links; sessions without log lines are filled in from their chapter. `STATS.md` has the numbers a paper needs: active time, who proposed ideas and decisions, rejected tool calls and interruptions, time from stuck to result, failures by error type, most edited files, and a per-session table. Both are regenerated whenever the journal is.

## Commands

`/research-log status` · `stats` · `index` · `import [--dry-run]` · `build` · `verify` · `cost` · `pause` · `resume` · `export [--with-raw]`

`import` copies a project's existing Claude Code transcripts (from before the plugin was installed) into the log. Claude Code deletes transcripts after about 30 days, so run it early in a project that is already under way.

Start a line of any message with `note:` to put your own words in the journal.

## What is stored, and where

Everything stays in the project folder. `raw/` and `state/` are gitignored, because they hold everything typed and every tool output. `journal/`, `documentary/`, `TIMELINE.md` and `DOCUMENTARY.md` are meant to be committed; secrets matching common key patterns are replaced with `[REDACTED:…]` in them. Nothing is sent anywhere.

## Turning it off

- One folder: create `.research-log/OFF`.
- Everywhere: set `RESEARCH_LOG=0`.
- Only the occasional reminder: set `RESEARCH_LOG_NUDGE=0`.

## Requirements

Bash (Git Bash on Windows) for capture. Node.js 18+ for the journal and documentary; without Node, capture keeps working and the journal is generated once Node is available.

## Development

`bash tests/run.sh` runs all automated tests (`RL_SKIP_BIG=1` skips the 200 MB case). `SCHEMA.md` records the hook payloads and transcript fields the code relies on.
