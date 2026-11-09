---
name: project-memory
description: Maintain this folder's portable handoff memory in .project-memory/ (a backup alongside built-in memory, so a new chat or person can continue without re-explaining). Use at a [project-memory] checkpoint; when a plan is made or changed (plan mode, "make a plan", agreeing on steps to build something), to save or update PLAN.md; on "handoff", "wrap up" or "I'm done"; when asked what's next, what changed, or why something was done; when the Overview says "Not filled in yet"; or after a decision, a gotcha, a working command or progress on the current work.
---

# Project memory

`.project-memory/` is a portable handoff copy of this project's knowledge, stored physically in the folder. Claude's built-in memory stays primary; keep using it as normal. This copy exists so a new chat, another account or another person can continue the work without anyone re-explaining it. `.claude/CLAUDE.md` imports `MEMORY.md`, so every Claude Code loads it, with or without this plugin.

**Before your first memory edit in a session, read `.project-memory/RULES.md` and follow it.** It is the single source of truth for the format, the history lines, and how to look things up cheaply.

If `.project-memory/` is missing (the hook didn't run), create it by copying `MEMORY.md`, `RULES.md` and `history/SUMMARY.md` from this skill's `templates/` folder. Then add the line `@../.project-memory/MEMORY.md` to `.claude/CLAUDE.md`.

## Triggers

- **`[project-memory] Checkpoint`** (every 2 user messages, and after a git commit): follow the Checkpoint section of `RULES.md`. Add history lines, update Current work and `PLAN.md`, then give the user the 2–4 line "done so far / plan from here" summary. If nothing meaningful happened, end the turn with no message.
- **A plan is made** (plan mode, "make a plan", or agreeing on steps to build something): save it to `PLAN.md` following the Plans section of `RULES.md` before starting the work. Keep its step status current as you go.
- **Handoff ("handoff", "wrap up", "I'm done", or the session is clearly ending):** follow the Handoff section of `RULES.md`.
- **"What's next?" / "where were we?":** answer from `MEMORY.md`, which is already in context.
- **"Why did we …?" / "what changed since …?":** answer from the `[project-memory] Recall` block that arrives with the message (a ranked search of every entry). If it doesn't cover the question, search `history/` as described in `RULES.md`. Never read the whole folder. If the recall says "No memory entry contains: X", there is no record of X.
- **"Remember X" (about the project):** save it here, log it and confirm in one line. Facts about the user go in built-in memory.
- **"Forget X":** remove the entry and log a `removed` line.
- **`/project-memory`:** show Overview and Current work, list the topics, and point out anything stale or over budget.
- **Hook warnings** (paths not found, new commits, a missing month summary, over budget): fix the affected entries and log the fixes.
- **Portable mode** ("portable mode", "make the memory work without the plugin", "set this folder up for handoff"): the folder gets its own copy of the hooks in `.project-memory/bin/`, registered in `.claude/settings.json`, so any Claude Code that opens and trusts the folder gets recall, checkpoints and plan saving.
  1. Tell the user in two lines what it does, and that whoever opens the folder and trusts it runs these scripts (they only read memory and write a cache under the temp folder). Ask before turning it on.
  2. Run `bash "<this skill's base directory>/../../hooks/portable.sh" enable`.
  3. If it prints `MERGE NEEDED` (exit 3), the project already has `.claude/settings.json`: add the printed hooks to it with an edit, keeping every existing setting and hook, and appending to any event that already has hooks. Then run the same script with `status`.
  4. Tell them to commit `.project-memory/` and `.claude/settings.json`.
  - To turn it off, run it with `disable`. On `REMOVE NEEDED`, delete only the hooks whose command mentions `.project-memory/bin/`.
  - On a startup warning that `.project-memory/bin/` differs from the plugin's copy, tell the user, and don't run or edit those scripts yourself. Offer to restore them by turning portable mode off and on.
- **First time memory comes up in a git repo:** ask whether to commit `.project-memory/` and `.claude/CLAUDE.md` (shared with clones; this is what makes handoff through git work) or to add `.project-memory/` to `.gitignore`.
