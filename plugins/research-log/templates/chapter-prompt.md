Read {DIGEST}. It is a compressed record of one working session. U = user, A = assistant, X = failed or rejected command, E = files edited, C = commit, L = log line, S = session event (compaction, off-the-record gap). Times are UTC; a line like `--- 2026-11-17 ---` starts a new day.
Write {CHAPTER}, at most 500 words. Its first line is the digest's first line, copied exactly. Then exactly these parts:
# <date> — <5 to 8 word title>
**Goal:** one sentence.
## What happened
4 to 10 bullets in time order, each starting with the time.
## Stuck points
What blocked us, what was tried, how it was resolved or "unresolved at end of session".
## Ideas and who proposed them
Each marked (user) or (claude).
## Decisions
Choice, reason, rejected alternative.
## Dead ends
What failed and why.
## Results
## Open at the end
Rules: use only what the digest says. Never guess a reason; write "reason not recorded". Exact words from the digest go in "double quotes"; nothing else goes in double quotes. A part with nothing to say gets the word "none". Reply with only: done.
