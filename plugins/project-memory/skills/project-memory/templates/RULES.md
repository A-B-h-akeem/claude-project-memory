# How to maintain this project memory

This folder is a **portable handoff copy** of the project's knowledge. Claude's built-in memory stays the primary memory; keep using it as normal. This copy travels with the project folder, so a new chat, another Claude account or another person can continue the work without anyone re-explaining it. Record what they would need to carry on. Personal facts about the user belong in built-in memory, not here, because this folder may be handed to someone else.

`MEMORY.md` is loaded into every Claude Code session through `.claude/CLAUDE.md`, so every byte of it costs tokens in every session. Keep it dense, and put detail in topic files and history.

## Files

| File | Read | Holds |
|---|---|---|
| `MEMORY.md` | every session (keep under 4 KB) | Overview, Current work, Rules & gotchas, Topics |
| `PLAN.md` | before starting or finishing a plan step | the current build plan with step status (only when a plan exists) |
| `<topic>.md` | when its Topics line matches the task | detail on one subject, such as `auth.md` |
| `history/YYYY-MM-DD.md` | only through search | one line per event that day |
| `history/SUMMARY.md` | for "what's the story so far" | one line per month |
| `RULES.md` | before editing memory | this file |
| `bin/` | run by Claude Code, if present | portable mode: the memory hooks, registered in `.claude/settings.json` (see `bin/README.txt`). Don't edit them. |

## MEMORY.md sections

- **Overview:** 1–5 lines covering what the project is, the stack, how to run it and where the code lives.
- **Current work:** what someone picking up the folder needs first. Replace it to keep it current; don't append.
  - **Goal:** what we're trying to achieve right now.
  - **Plan:** `PLAN.md` and its current step (e.g. "`PLAN.md`, step 3 of 7"), or "none".
  - **Done:** finished pieces relevant to the goal.
  - **In progress:** what's half-done, and where (files, branch).
  - **Next:** numbered next steps, specific enough to start on without asking.
  - **Blockers / open questions:** what's stuck, or what needs a decision from the user.
  - **Updated:** date and who updated it.
- **Rules & gotchas:** one line each, only things that matter in most sessions (at most about 15).
- **Topics:** one line per topic file, written as a trigger, e.g. `` - `auth.md`: read before touching login or sessions. ``

Topic files hold terse bullets under a title like `# Auth (updated 2026-11-09)`.

## History

Each day's events go in `history/YYYY-MM-DD.md`, one line per event, with no header. Use this exact format so a single search finds them:

```
type | area | what happened (why) | `files`
```

- **type** is one of: `decision`, `done`, `change`, `fix`, `gotcha`, `removed`, `handoff`.
- **area** is one lowercase word: a topic file name where one exists (`auth`, `deploy`), otherwise the part of the project (`db`, `ui`, `build`).
- Each line is under about 160 characters. Files and the reason are optional but valuable.
- **Search tags:** when someone might ask about the event in other words, end the line with 1–3 tags, e.g. `… (Render cold starts 9 s) | \`fly.toml\` #hosting #latency`. Entries are found by the words they contain, so a tag like `#sunset` lets "when is v1 shut down?" find "API v1 deprecated".

```
decision | db | SQLite, not Postgres (single-user app, zero setup) | `src/db.py`
done | cli | delete command works, with tests | `todo.py`
removed | auth | dropped NextAuth (broke the vendor/admin split) |
handoff | - | Current work rewritten; next: list command |
```

Writing:
- The first event of the day creates the file. Later events that day append to it.
- Never edit or delete past lines. If something is reversed, add a new line saying so.
- When a month has ended, add one line for it to `history/SUMMARY.md`: `- 2026-11: built CLI add/delete; chose SQLite; first release`. Write it from that month's `decision` and `done` lines; don't re-read the whole month.

## Plans

Create `PLAN.md` whenever a plan is made: in plan mode, when the user asks for a plan, or when you agree on a multi-step approach for building something. Small one-step tasks don't need one. Format:

```
# Plan: <goal in one line>
Created 2026-11-09 · Updated 2026-11-09

## Steps
- [x] 1. Set up project skeleton (`src/`, `package.json`)
- [ ] 2. Add login with JWT cookies; done when `npm test` passes auth tests
- [ ] 3. ...

## Constraints and decisions
- No external DB: must run offline.

## Open questions
- Hosting: Vercel or VPS? (waiting on the user)
```

- One line per step, starting with `- [ ]` or `- [x]`, and say what "done" means when it isn't obvious.
- Tick steps off as they're finished; edit, add or remove steps when the plan changes, and log a `change | plan | …` history line.
- Keep `Current work → Plan` pointing at the current step, and add a Topics line: `` - `PLAN.md`: the build plan; read before starting or finishing a step. ``
- When a plan is finished or replaced, copy it to `history/plan-YYYY-MM-DD-<slug>.md` (dated when it was created) and log a `done | plan | …` or `change | plan | …` line. Then remove `PLAN.md`, or write the new plan in its place.

## Checkpoint

A checkpoint happens every 2 user messages and after every git commit. With the plugin installed, a `[project-memory] Checkpoint` message asks for it; without the plugin, do it yourself at the same points. At each checkpoint:
1. **History:** add one line per event since the last checkpoint to today's `history/YYYY-MM-DD.md`.
2. **Memory:** update Current work, tick off or adjust `PLAN.md` steps, and save any new decision, gotcha or command.
3. **End your reply with this summary for the user:**

```
**Checkpoint**
- Done so far: delete command, JSON storage, tests for add/delete
- Plan from here: list command, then packaging (PLAN.md step 4/6)
- Open: icon for the installer?
```

Only if nothing at all happened since the last checkpoint (just questions answered, no progress or decisions), skip all three and say nothing.

## What to save

Save anything a new chat would otherwise need re-explained, or would get wrong:
- **Decisions, with the reason**, plus rejected alternatives.
- **Gotchas**: things that look wrong but are intentional, environment quirks, flaky steps.
- **Commands** you've seen succeed (build, test, run, deploy, migrate).
- **Project conventions** the user stated that the code doesn't already enforce.
- **Current work**, after every meaningful step.

Don't save:
- **Secrets, ever.** Record where a secret lives ("DB URL: `.env`, `DATABASE_URL`"), never its value.
- Anything the code, README or git log already states plainly.
- Chat-only details, or debugging steps that went nowhere.

## Writing rules

1. **Edit, don't duplicate.** One fact lives in one place in `MEMORY.md` or a topic file. History records the event.
2. **Log each change** as a history line, in the same step.
3. **Code wins.** If memory disagrees with the code, fix the memory and log a `fix` line.
4. **Paths in backticks, relative to the project root.** That lets missing paths be detected.
5. **Absolute dates**, never "yesterday".
6. **Promote and demote.** A fact needed in most sessions moves up to Rules as one line. If `MEMORY.md` passes 4 KB, move detail down into topic files.
7. **Say what you saved** in one line, e.g. `Memory: Next updated, logged.` Say nothing when nothing changed.

## Finding things (cheapest first)

1. **`MEMORY.md`** is already in context. With the plugin installed, each message also arrives with a `[project-memory] Recall` block: the entries from topic files, plans and all of history that best match the message. Check it first; it often holds the answer.
2. **A topic file** whose Topics line matches the task.
3. **History, through search only.** Use a content search over `.project-memory/history/` that returns matching lines, never whole files:
   - Everything about one area: search `\| auth \|`
   - All decisions: search `^decision`
   - "Why did we …?": search the keyword, and look at the `decision` and `removed` lines
   - What changed since a date: list the files in `history/` and read only the ones dated after it
   - Recent activity: read the newest 1–2 day files
   - The project's story so far: read `history/SUMMARY.md`
4. Before concluding that memory has nothing on a subject, search all of `.project-memory/` for the keyword.

## Handoff

Before stopping work, or when the user says "handoff", "wrap up" or "I'm done":
1. Rewrite **Current work** completely, so a newcomer could start on **Next** step 1 without asking anything.
2. Mention uncommitted changes or unfinished edits under **In progress**.
3. Bring `PLAN.md` step status up to date, if there is a plan.
4. Save any decisions or gotchas from this session that aren't recorded yet.
5. Add a `handoff` line to today's history file, and give the user the checkpoint summary.
