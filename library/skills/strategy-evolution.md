---
name: strategy-evolution
description: Use when distilling lessons, writing notebook entries, or proposing agent strategy revisions
agents: coach
---

# Strategy evolution

Proposals auto-apply under the operator's autonomy grant. That makes discipline the whole job: a sloppy proposal ships instantly.

## One change at a time

- Change at most one meaningful behavior per agent per proposal. Multi-change proposals make version performance unattributable.
- The version history carries grade-at-adoption vs grade-at-retirement for every strategy. A version that rode a falling grade is evidence AGAINST its approach; reverting is a legitimate proposal.
- Never remove factual grounding, risk framing, or charter compliance from a strategy — those clauses are why drafts get approved.

## Proposal hygiene (added 2026-09-10)

- Return the COMPLETE replacement text as one coherent strategy. Never write 'Added in vN' append blocks: that style put the identical sentence 'Lead with the fixed 666,666 swap unit' into narrative's strategy in v2, v3, v5 and v6, and that sentence became the spine the critic vetoed three times in one cycle.
- Before submitting, diff the new text against the current version sentence by sentence. Drop any sentence already present. A proposal that adds nothing new is not submitted.
- Every proposal removes or rewrites the clause behind the latest veto or rejection AND adds exactly one tactic. Removing the rejected clause and adding its replacement counts as the one change.
- Do not spend two consecutive cycles on the same agent unless a rejection forces it. An agent at v1 with no rejection is not 'weak' merely because it is untuned.

## Reading the signal under auto-approval

- Every producer draft is stamped 'Auto-approved: full autonomy enabled', so approval ratios carry no information. The critic's vetoes are the only rejection signal, and they count as rejections in the execution component (73/77 = 97 on 2026-09-10). Rank agents by vetoes and the pattern the vetoes name, then by grade-component deltas, duplicate titles in the digests, and run-log health.
- Two vetoes on the same shape of work from one agent (the incident-recovery rule) force a proposal for that agent this cycle, even if its version is young.
- Strategy text cannot fix an agent that produces nothing when invoked (scout v1-v6: 0 drafts). Log it as an incident; do not spend a slot.

## Lessons vs notebook

- **Lesson** = tactical, evidence-backed, about what moves the grade or reviewers ('threads with unsourced claims get rejected').
- **Notebook** = durable reference the swarm should never re-learn (verified mechanics, addresses, operator context, working parameter ranges). Same topic overwrites — keep facts current instead of appending contradictions.
- Don't record what the library already says; record what the library is missing.
- When a memory item is superseded (e.g. 'the critic produces nothing'), write the superseding lesson and name what it retires; never leave a known-false item uncorrected.

## Skill editing (your third lever)

- Besides lessons/notebook and strategy proposals, you may return ONE `skillEdit` per cycle: it creates or replaces a markdown file in `/library/skills` and reaches every listed agent's prompts from the next cycle. Reusing an existing skill name replaces that file wholesale — always return the complete new text, keeping every verified fact the old version carried.
- Edit a skill only on concrete evidence the current text is wrong, missing or stale (a repeated failure pattern, a verified mechanic the skill contradicts). Strategy problems belong in strategy proposals; skills are cross-version operating procedure.
- You cannot touch code, launch caps or anything outside `/library/skills`; the write path enforces this and caps the library at 16 skill files — prefer updating over creating.

## Operational health (you own it)

- Your prompt carries an OPERATIONAL HEALTH digest: cycle durations, LLM fallbacks, schema repairs, error/skipped steps. A fallback means an agent ran on canned output — treat repeated fallbacks or repairs on one agent as a bug to fix via lesson or skill edit (usually the agent's output is overflowing a schema limit).
- Two consecutive failed cycles emit a `swarm.health` event in the console. If you see one in the event stream, diagnosing it outranks content work that cycle.
- A cycle over ~300s with no extra output is an incident: name it in the run log and trim prompt load (overwrite notebook topics, retire superseded memory, max 3 lessons).

## Red flags

- A proposal whose rationale doesn't cite a number, an approval/rejection, or a version comparison
- Rewriting a strategy that's less than 3 cycles old (not enough evidence yet) unless two vetoes force it
- A lesson that restates the charter
- A proposal written as an 'Added in vN' append instead of complete text, or one whose added sentence already exists in the strategy
- A rationale that justifies a rewrite with an approval ratio
