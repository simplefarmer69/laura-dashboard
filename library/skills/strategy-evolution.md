---
name: strategy-evolution
description: Use when distilling lessons, writing notebook entries, or proposing agent strategy revisions
agents: coach
---

# Strategy evolution

Proposals auto-apply under the operator's autonomy grant. That makes discipline the
whole job: a sloppy proposal ships instantly.

## One change at a time

- Change at most one meaningful behavior per agent per proposal. Multi-change proposals
  make version performance unattributable.
- The version history carries grade-at-adoption vs grade-at-retirement for every
  strategy. A version that rode a falling grade is evidence AGAINST its approach;
  reverting is a legitimate proposal.
- Never remove factual grounding, risk framing, or charter compliance from a strategy —
  those clauses are why drafts get approved.

## Lessons vs notebook

- **Lesson** = tactical, evidence-backed, about what moves the grade or reviewers
  ("threads with unsourced claims get rejected").
- **Notebook** = durable reference the swarm should never re-learn (verified mechanics,
  addresses, operator context, working parameter ranges). Same topic overwrites — keep
  facts current instead of appending contradictions.
- Don't record what the library already says; record what the library is missing.

## Skill editing (your third lever)

- Besides lessons/notebook and strategy proposals, you may return ONE `skillEdit` per
  cycle: it creates or replaces a markdown file in `/library/skills` and reaches every
  listed agent's prompts from the next cycle. Reusing an existing skill name replaces
  that file wholesale — always return the complete new text, keeping every verified
  fact the old version carried.
- Edit a skill only on concrete evidence the current text is wrong, missing or stale
  (a repeated failure pattern, a verified mechanic the skill contradicts). Strategy
  problems belong in strategy proposals; skills are cross-version operating procedure.
- You cannot touch code, launch caps or anything outside `/library/skills`; the write
  path enforces this and caps the library at 16 skill files — prefer updating over
  creating.

## Operational health (you own it)

- Your prompt carries an OPERATIONAL HEALTH digest: cycle durations, LLM fallbacks,
  schema repairs, error/skipped steps. A fallback means an agent ran on canned output —
  treat repeated fallbacks or repairs on one agent as a bug to fix via lesson or
  skill edit (usually the agent's output is overflowing a schema limit).
- Two consecutive failed cycles emit a `swarm.health` event in the console. If you see
  one in the event stream, diagnosing it outranks content work that cycle.

## Red flags

- A proposal whose rationale doesn't cite a number, an approval/rejection, or a version
  comparison
- Rewriting a strategy that's less than 3 cycles old (not enough evidence yet)
- A lesson that restates the charter
