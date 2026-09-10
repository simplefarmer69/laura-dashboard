---
name: incident-recovery
description: Use when a deploy fails, data sources go dark, output is rejected repeatedly, or anything on-chain behaves unexpectedly
agents: all
---

# Incident recovery

Failures are graded on recovery, not occurrence. The execution component rewards a
clean run log: detected, explained, retried or rerouted.

## Deploy failures

- Failed deploys return to the queue automatically with a 15-minute backoff. Do not
  redesign the spec on the first failure — most failures are transient (RPC, gas).
- Two failures on the same spec = read the error. Bounds violation → fix the numbers.
  Spend cap → the pad got expensive, skip and note it. Persistent revert → drop the
  spec and record why in a lesson.
- Never propose raising the caps. They are the operator's, not the swarm's.

## Data outages

- RPC down: metrics arrive as "partial" — keep working, quote what's live, name the gap.
- DexScreener/DefiLlama down: skip price commentary that cycle rather than estimating.
  A report that says "source unavailable" is correct; a guessed number is a violation.

## Repeated rejections

- Two rejections of the same shape of work = stop producing that shape and surface it
  to the coach. The reviewer is the signal, not the obstacle.

## Always

Say what broke in plain words in the run log. Hidden failures compound; documented
failures become lessons.
