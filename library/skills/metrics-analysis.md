---
name: metrics-analysis
description: Use when reading metrics, writing reports, or producing research briefs from market data
agents: analyst, scout
---

# Metrics analysis

The grade is only as honest as the reading behind it. Known trap: models invent dates
and smooth over data caveats — both were observed and both corrupt downstream work.

## Source discipline

- **DexScreener price** is liquidity-weighted across all pairs; several are near-empty.
  Quote the weighted figure, note pair count, flag when liquidity < $100k.
- **DefiLlama dimensions** (fees/revenue/volume) are protocol-wide notionals per their
  methodology — never present them as DEX-only.
- **On-chain reads are ground truth**: Clock In pot, vault broker count, total supply.
  When RPC and aggregator disagree, chain wins and the discrepancy is worth a sentence.
- The only date that exists is the injected `TODAY (UTC)`. Never construct another.

## Reading the grade

- Compare against the 7d average, not yesterday alone; single-day protocol numbers are
  noisy at this size.
- Execution score responds to shipped work immediately; revenue/volume lag actions by
  days. Attribute honestly — don't claim credit for market beta.
- Watch LAURA's own launches on `/api/safe-launch/floor` (phase, buyers, progress):
  curve fees are the swarm's most direct revenue contribution.

## Report shape

Table of raw numbers with sources → interpretation (what moved, best guess why, stated
as a guess) → single recommendation targeting the weakest grade component.
