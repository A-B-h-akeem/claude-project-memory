# Research log

This folder is written by the `research-log` Claude Code plugin. It records how this project was built (what we asked, what failed, where we got stuck, which ideas came from whom, what was decided and what was abandoned) as source material for a later research paper.

| Path | What | In git |
|---|---|---|
| `raw/` | exact copy of every Claude Code session transcript for this folder | no (local only) |
| `journal/` | one file per session: a timeline extracted from `raw/` by a script, no AI involved | yes |
| `TIMELINE.md` | all journal files in order | yes |
| `INDEX.md` | every decision, stuck point, idea, dead end, result, insight and note across sessions, with links | yes |
| `STATS.md` | numbers for a paper: active time, who proposed ideas and decisions, rejections and interruptions, time from stuck to result, failures by error type, most edited files | yes |
| `documentary/`, `DOCUMENTARY.md` | narrative chapters, written only when you run `/research-log build` | yes |
| `state/` | offsets, counters, error log | no |

Journal lines look like `17:42:10 | stuck | claude | preflight fails only on PUT | L231`; `L231` is the line in the raw transcript the event came from. Secrets matching common key patterns are replaced with `[REDACTED:…]` everywhere outside `raw/`.

- Log something yourself: start a line of your message with `note:`.
- Bring in sessions from before the plugin was installed: `/research-log import` (Claude Code deletes transcripts after about 30 days, so do this early). `--dry-run` shows what would be imported.
- Numbers and the cross-session list: `/research-log stats`, `/research-log index`.
- Off the record: `/research-log pause`, then `/research-log resume`. The skipped range is recorded, so the gap is visible.
- Check health: `/research-log status` or `/research-log verify`.
- Turn off for this folder: create an empty file `.research-log/OFF`. Everywhere: set `RESEARCH_LOG=0`. Only the occasional reminders: `RESEARCH_LOG_NUDGE=0`.
