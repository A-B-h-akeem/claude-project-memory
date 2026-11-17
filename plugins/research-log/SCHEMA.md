# Confirmed facts (plan step 1, 2026-11-16, Claude Code 2.1.325 on Windows 11, Git Bash)

Source: spike plugin run in headless sessions (`claude -p --plugin-dir`), plus 195 local transcripts.

## Assumptions V1–V7
| # | Result | Evidence / consequence |
|---|---|---|
| V1 | true | `"timeout"` on a hook entry passes `claude plugin validate` and loads |
| V2 | false in headless mode | after `/compact`, no SessionStart with `source: compact` fired. Fallback in use: the `prompt` hook re-sends the rule when its batch contains a `compact_boundary` line (skipped if a `start` with `source: compact` already sent it) |
| V3 | true | PreCompact: `session_id`, `transcript_path`, `cwd`, `trigger`, `custom_instructions`. SessionEnd: `session_id`, `transcript_path`, `cwd`, `reason` |
| V4 | true for compaction and resume | transcript grew 321 KB -> 626 KB across `/compact`; resume appends to the same file. The shrink rule stays as a guard |
| V5 | true, with additions below | field names as listed below |
| V6 | not testable headless | design does not depend on it (next prompt/start sync covers both cases) |
| V7 | true | `disable-model-invocation: true` hid `spike:echo` from the model's skill list while `spike:zebra-visible` stayed; `/spike:echo hello world` produced `ARG=[hello world]` |

## Hook payloads (all events)
- Common: `session_id`, `transcript_path` (Windows form, JSON-escaped: `C:\\Users\\...`), `cwd`, `hook_event_name`.
- SessionStart: `source` = `startup` | `resume` (also `clear` / `compact` per docs, not observed). Resume adds `seconds_since_last_response`, `context_tokens`.
- UserPromptSubmit: `prompt_id`, `permission_mode`, `prompt`.
- Stop: `stop_hook_active`, `last_assistant_message`, `effort`, `background_tasks`. Fires a second time with `stop_hook_active: true` when another plugin blocks.
- SessionStart plain stdout reaches the model (confirmed with a marker word).
- Env in hooks: `CLAUDE_PROJECT_DIR` = `C:/Users/...` (forward slashes). `PWD` may be a Git Bash mount such as `/tmp/...`.

## Transcript lines
- One JSON object per line. Kinds by top-level `type`: `user`, `assistant`, `system`, `attachment` (hook output, reminders), plus bookkeeping lines `last-prompt`, `mode`, `permission-mode`, `session-owner`, `ai-title`, `tools-used`, `file-history-*`, `atis-latch`, `api-request`, `api-request-shape`, `api-request-blob`.
- `api-request*` lines repeat message content (34% of bytes in one session). Counting in bash skips lines starting `{"type":"api-request`; rlog.js only reads `user`, `assistant`, `system`.
- Message lines carry `uuid`, `parentUuid`, `timestamp` (ISO UTC), `sessionId`, `gitBranch`, `isSidechain`, `cwd`.
- Assistant: one line per content block; `message.content[]` items `thinking`, `text`, `tool_use` (`id`, `name`, `input`).
- User prompt: `type: user`, `promptSource` = `typed` | `sdk` | `queued` | `suggestion_accepted` | **`system`** (task notifications; excluded). Content is a string. Slash commands (`<command-name>…`) have no `promptSource`.
- Tool result: `type: user`, `message.content[]` item `tool_result` with `tool_use_id`, `content` (string or array of `{type:text}`), `is_error`.
- Rejected tool: `tool_result` `is_error: true`, content starts `The user doesn't want to proceed with this tool use.`; line has `toolDenialKind: "user-rejected"`.
- Interrupt: `type: user`, content item `{type:text, text:"[Request interrupted by user]"}` (also `… for tool use]`); line has `interruptedMessageId`.
- Compaction: `type: system`, `subtype: compact_boundary`, `content: "Conversation compacted"`, `compactMetadata.trigger`.
- Sizes: transcripts reach 66 MB. Each sync copies at most 32 MB (rest on the next sync) so a hook timeout cannot cause repeated partial copies.

## Gotchas found
- Git Bash rewrites a leading-slash argument such as `/compact` into `C:/Program Files/Git/compact`; with `MSYS_NO_PATHCONV=1` it also stops converting `/c/...` paths, so pass Windows paths (`cygpath -w`) then.
- A `cat > file` with no heredoc in the Bash tool waits on stdin forever.
