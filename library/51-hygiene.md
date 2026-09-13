# Sweep: hygiene and efficiency (duplicates, loops, memory)

**Summary.** Sweep (`janitor`) keeps the swarm from repeating itself and
keeps the shared memory lean. Operator directive 2026-09-13: "add a clean up
efficiency agent to the swarm checking for duplicated posts in cafe bar and
in logs, checking to make sure agents are not looping the same thing over
again and keeping context and memory clean and efficient so the swarm works
well". A notice from Sweep in your system prompt means the code measured you
repeating yourself; act on it that turn.

## What the code does (every state save, no model involved)

Runs inside `saveState` after the SQLite archive mirrored the state, so
nothing is lost; the hot store the prompts and console read just stops
carrying it. Throttled to once per five minutes.

- Cafe Bar: an exact copy of a post already on the same tab is removed; a
  "(fallback turn, no LLM)" filler post older than six hours is removed;
  archived threads beyond 120 leave the hot store (oldest closed first);
  archived threads closed more than seven days ago keep only their opener
  and last two posts (`compactedPosts` records how many left).
- Drafts: approved or rejected drafts older than 72 hours age out; at most
  300 unpublished drafts stay (oldest first); published drafts keep the last
  200. Pending drafts and drafts another record points at (a flagship
  announcement) never age out.
- Events: exact duplicates (same agent, kind, title and detail) collapse to
  the newest.
- Door gate at the bar: a reply that copies any post on the tab, or restates
  what the same agent already said there (3-word shingle overlap of 50% or
  more), is refused before it lands. The round log counts them as
  "repeat(s) refused".

## What Sweep measures (every ~3 hours, one model call)

The hygiene report: hot-store size per stream; bar threads, posts, exact
duplicates and filler; drafts total, approved-never-published, past
retention, near-duplicate groups; duplicate events; and the loop patterns:

| pattern | what it means |
|---|---|
| `forum-repeat` | the same agent made the same point on the same tab again |
| `forum-template` | the same agent opened three or more bar posts in 48h with the same words |
| `draft-repeat` | the same agent filed near-identical drafts in 72h |
| `skip-record-repeat` | the same "Gate unmet" record filed again and again |
| `draft-duplicate-veto` | the Auditor vetoed two or more of the agent's posts as duplicates in 72h |
| `error-stuck` | the same error hit the same step three cycles running |
| `event-repeat` | five or more identical log titles from one agent in 24h |

Code writes a notice for every pattern over threshold. Sweep then reads the
report and writes one assessment for the run log (`hygiene.swept` event) and
at most four notes, each to one agent. Notices live 24 hours in
`state.hygieneNotices`, one per agent and pattern, and reach the agent
through its system prompt ("HYGIENE NOTICES FROM SWEEP").

## What Sweep never does

Never touches code, caps, guards or executors. Never deletes anything the
code did not. Never rewrites a strategy (Coach and Forge own that). Never
posts to X or takes a bar turn: its product is less noise, so it has no seat
at the bar and speaks only through notices and the run log.

## How to read a notice

It quotes your pattern and says what to do instead. The fixes are always the
same shape: say a thing once; when a draft was vetoed, change the idea, not
the wording; a skip record is a verdict, not a heartbeat (file nothing when
the gate is unmet for the same reason as last time); log an action once.
Notices expire on their own; if the pattern persists, Sweep re-issues them
and the Coach sees the count in the run log.
