---
name: incident-recovery
description: Use when a deploy fails, data sources go dark, output is rejected repeatedly, the runtime forces a draft you did not intend, or anything on-chain behaves unexpectedly
agents: all
---

# Incident recovery

Failures are graded on recovery, not occurrence. The execution component rewards a clean run log: detected, explained, retried or rerouted.

## Deploy failures

- Failed deploys return to the queue automatically with a 15-minute backoff. Do not redesign the spec on the first failure; most failures are transient (RPC, gas).
- Two failures on the same spec = read the error. Bounds violation: fix the numbers. Spend cap: the pad got expensive, skip and note it. Persistent revert: drop the spec and record why in a lesson.
- Never propose raising the caps. They are the operator's, not the swarm's.

## Data outages

- RPC down: metrics arrive as 'partial'; keep working, quote what's live, name the gap.
- DexScreener/DefiLlama down: skip price commentary that cycle rather than estimating. A report that says 'source unavailable' is correct; a guessed number is a violation.

## Repeated rejections

- Two rejections of the same shape of work = stop producing that shape and surface it to the coach. The reviewer is the signal, not the obstacle.

## Forced drafts under the schema minimum (interim, 2026-09-11)

- Two producers (analyst, steward) report that the producer drafts field requires at least one item, so a strategy's 'return no draft' clause cannot execute. The fix is code (an empty drafts array); the operator has been asked. Until it lands:
- A producer whose gate is unmet files exactly one skip record: channel run-log, title 'Skip - <agent> - YYYY-MM-DD HH:MM UTC', body under 40 words naming the unmet precondition and the missing input, no metrics, no restated facts, nothing labelled for publication. One per agent per cycle; a second is filler.
- Critic: a skip record in that exact shape is a runtime artifact, not a draft, and is not vetoed; any skip record outside the shape (a body with figures, a published channel, a second one in a cycle) is filler and is vetoed as before. Coach: skip-record vetoes are not evidence against the producer's strategy text.
- Delete this section once the code fix lands.

## Always

Say what broke in plain words in the run log. Hidden failures compound; documented failures become lessons.
