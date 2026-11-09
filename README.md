# project-memory

A Claude Code plugin that keeps a **portable handoff memory** in every project folder. It's a backup alongside Claude's built-in memory, which stays primary. Hand the folder to a new chat, another account or another person, and they pick up where you left off: what the project is, what's been decided and why, what's done and what's next. Nobody has to re-explain anything, and it costs a few hundred tokens instead of a re-read of the codebase.

## What gets created in each project

```
your-project/
├── .claude/CLAUDE.md          one line: @../.project-memory/MEMORY.md  (makes ANY Claude Code load the memory)
└── .project-memory/
    ├── MEMORY.md              loaded every session (4 KB budget): Overview, Current work, Rules & gotchas, Topics
    ├── RULES.md               how to maintain the memory, read before editing it, travels with the folder
    ├── PLAN.md                the current build plan with step status (only when a plan exists)
    ├── history/
    │   ├── SUMMARY.md         one line per month: the project's story at a glance
    │   ├── YYYY-MM-DD.md      one line per event:  type | area | what (why) | `files`
    │   └── plan-YYYY-MM-DD-*.md   finished or replaced plans
    └── <topic>.md             detail (auth.md, deploy.md, …), opened only when relevant
```

The folder is self-contained. Whoever receives it doesn't need this plugin: Claude Code loads `MEMORY.md` through `.claude/CLAUDE.md`, and `RULES.md` tells the receiving Claude (or person) how to keep the memory up to date.

## Architecture: smart writes, mechanical reads

Benchmarks showed that every recall failure was a retrieval failure: the fact was stored, but Claude didn't search, or searched with the wrong words. Tokens were driven by turns, because every search turn re-sends Claude Code's ~16,000-token system prompt. So retrieval doesn't depend on Claude deciding to search:

| Tier | What | Cost per message |
|---|---|---|
| **Hot** | `MEMORY.md` index (overview, current work, rules), loaded through `CLAUDE.md` | ~400 tokens |
| **Recall** | On every message, `hooks/recall.sh` ranks every entry (history lines, monthly summaries, plan steps, topic bullets) against the message with BM25 and injects the best 8, oldest first, plus words that no entry contains | ~140 tokens, 0 turns |
| **Cold** | Claude searches `history/` itself if recall wasn't enough | only when needed |

Writes are where Claude has full context, so that's where the care goes: one dated line per event with its reason, and search tags (`#hosting #sunset`) when someone might ask in other words.

Recall is plain bash + POSIX awk with a one-file search cache, rebuilt only when memory changes. On a Windows laptop it adds 0.25 s per message at 1 year of history, 0.32 s at 3 years and 0.42 s at 5 years (12,439 entries).

### Benchmark (30 questions, a year of history, Claude Haiku 4.5)

| Setup | Correct | Median tokens per answer | Turns |
|---|---|---|---|
| **v3: recall hook** | **30/30** | **16,662** | 1 every time, no tool calls |
| v2: index hint to search | 29/30 | 53,465 | ~3 |
| v1: first version | 27/30 | 49,854 | ~3 |
| Everything in one notes file | 30/30 | 96,741 | 1 |
| Empty folder (Claude Code baseline) | – | 15,827 | 1 |

## How it works

| When | What happens | Token cost |
|---|---|---|
| First session in a folder without memory | Creates `.project-memory/` from templates and links it in `.claude/CLAUDE.md`. Claude fills in Overview and Current work as it learns the project. | ~160 tokens, once |
| Every session start | Claude Code loads `MEMORY.md` through `CLAUDE.md`. The hook prints nothing unless something needs attention. | the index (~200–1,000 tokens) |
| Every message | **Recall:** the best-matching memory entries are added to the message, and words with no match are named, so Claude can say "not recorded" without searching. | ~140 tokens, only when something matches |
| Something drifted | Flags paths in memory that weren't found, commits made since memory was last updated, and uncommitted changes. | a line or two, only when flagged |
| Every 2 messages, and after any `git commit` | **Checkpoint:** Claude adds history lines, updates Current work and `PLAN.md`, then shows you a summary (below). Stays silent if nothing happened. | one short turn |
| A plan is made (plan mode, "make a plan", "roadmap", "step by step"…) | A hook reminds Claude to save it as `PLAN.md` with checkbox steps. Checkpoints tick steps off; finished plans move to `history/`. | ~50 tokens, only on those messages |
| "handoff" / "wrap up" / "I'm done" | Claude rewrites Current work and the plan status, so a newcomer can start on the next step without asking. | one turn |
| "remember …" / "forget …" / "what's next?" / `/project-memory` | Saves, deletes or answers from memory. | — |

The checkpoint summary looks like this:

```
**Checkpoint**
- Done so far: CLI skeleton, JSON storage, add/list commands
- Plan from here: monthly totals, then CSV export (PLAN.md step 5/7)
- Open: none
```

Memory is kept outside `.claude/` on purpose: Claude Code asks permission for every edit under `.claude/`, which would interrupt every update.

No memory is created in your home directory or at a drive root. Secrets are never written to memory, only where they live.

## History, built for cheap lookups

Each event is one line in that day's file, with fixed fields, so one search returns exactly the lines needed:

```
decision | db | SQLite, not Postgres (single-user app, zero setup) | `src/db.py`
gotcha | cli | Windows terminal is cp1252; emoji in print() crashes |
```

Measured on a simulated year (3,650 events, about 98,000 tokens if read in full):

| Lookup | Cost |
|---|---|
| Log an event (read today's file, then append) | ~270 tokens |
| Recent activity (newest 2 day files) | ~540 tokens |
| "Why did we …?" (keyword search) | a few hundred tokens |
| A year of decisions in one area | ~2,000 tokens |
| The project's story (`SUMMARY.md`) | ~200 tokens |

The startup script reminds Claude to add a `SUMMARY.md` line for each finished month.

## Install

```
/plugin marketplace add <github-user>/claude-project-memory
/plugin install project-memory@abdul-plugins
```

From a local copy: `/plugin marketplace add C:/path/to/claude-project-memory`. Restart Claude Code after installing. Requires `bash`, which Claude Code already uses for hooks (Git Bash on Windows).

## Handing off a folder

- **Copy or zip:** include `.project-memory/` and `.claude/CLAUDE.md`.
- **Git:** commit both. Anyone who clones the repo gets the memory.
- **Keeping it private instead:** add `.project-memory/` to `.gitignore`.

Before handing off, tell Claude "handoff" so Current work is fully up to date.

### Portable mode: full memory without the plugin

Without the plugin, a receiver's Claude still loads `MEMORY.md` and follows `RULES.md`, but gets no recall, checkpoints or plan saving. Portable mode gives the folder its own copy of the hooks:

```
Tell Claude: "turn on portable mode"      (or: bash <plugin>/hooks/portable.sh enable)
```

This copies the scripts into `.project-memory/bin/` and registers them in `.claude/settings.json`. Commit both. Anyone who opens the folder in Claude Code and trusts it gets the same behaviour as the plugin.

Safeguards:

| Risk | What happens |
|---|---|
| Receiver also has the plugin | The plugin's copy stands down, so nothing runs twice. |
| The folder's scripts are older than the plugin | The plugin updates them at session start and says so. |
| The folder's scripts were altered | The plugin warns at session start. Without the plugin, Claude Code's "trust this folder" prompt is the gate, and `bin/README.txt` lists exactly what each script does (they read memory and write only a cache under the user's temp folder). |
| Project already has `.claude/settings.json` | It is never rewritten. Claude merges the hooks in by hand, keeping everything else. |
| Windows checkout converts line endings | `bin/.gitattributes` keeps the scripts LF, and recall strips stray CRs from memory files. |
| `bin/` deleted but hooks still registered | The hooks skip quietly instead of erroring on every message. |
| Shared machine | Cache and counters live in a per-user, owner-only temp folder. A cache owned by someone else is ignored. |
| Untrusted notes in a received folder | Recall labels its output as notes, not instructions. |
| A secret slipped into memory | Session start reports the file and line, without printing the value. |

Turn it off with "turn off portable mode" (or `portable.sh disable`). Memory files are kept.

## Tuning (environment variables)

| Variable | Default | Effect |
|---|---|---|
| `PROJECT_MEMORY_EVERY` | `2` | User messages between checkpoints. Lower catches more; higher costs fewer tokens and summaries. |
| `PROJECT_MEMORY_INDEX_BUDGET` | `4000` | Bytes of `MEMORY.md` before Claude is asked to condense it. |
| `PROJECT_MEMORY_RECALL_TOP` | `8` | Most entries recall adds to a message. |

## Uninstall

`/plugin uninstall project-memory@abdul-plugins`. Existing `.project-memory/` folders keep working in any Claude Code through their `CLAUDE.md` line. You lose only the automatic checkpoints and creation in new folders.
