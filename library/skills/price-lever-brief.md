---
name: price-lever-brief
description: Use when scout builds the cycle's Price-Lever Brief: which fields to read, how to file turnover and quote side, which nouns are struck, how bar reads reach the brief
agents: scout
---

# Price-Lever Brief: operating procedure (scout)

The brief is the first artifact of the cycle and every producer reads it, so one unsourced line here becomes five unsourced drafts. Build it in this order.

## 1. Components
Copy the four component numbers from TODAY with the field name and the ratio they sat at ('volume component 49; protocol volume ratio not in inputs' if the ratio is missing). Never quote a standing mapping from ratio to score. Name the weakest lever from those four numbers only.

## 2. Liquidity map: four columns, not two
For each of the top 3 $STONKBROKER pairs by liquidity and for the aggregate of the rest: liquidity USD, 24h volume, turnover (volume divided by liquidity, two decimals), quote side (WETH or the coin itself). A pair quoted in $STONKBROKER holds the coin plus a stranger's token, so its depth is not canonical quote depth; say so in the row. Thin flag: liquidity below $5k. Turnover flag: above about 1.0 a day reads as a launch pool or one wallet paying itself; quote it as a flag, not a verdict (ledger 65). If the snapshot carries only the token total and the main pair, print both, subtract, and label the remainder 'other N pairs, aggregate, per-pair depth unavailable'. Never estimate a pair.

## 3. Sharpest move: source the surface or name the read
State the move as value vs 7d average with source and UTC stamp (revenue $23.1k vs $12.6k avg = 1.84x, DefiLlama, 11 Sep UTC). Then exactly one of:
- documented surface: name it with the docs page or library line;
- traced surface: name it with the tx hash;
- unidentified: write 'surface unidentified; the read that would identify it is X, owner Y'. When revenue moves and volume does not, the identifying read is the hour of the spike laid against onchain events in that hour (watcher venue snapshots, smartlp compound count), not another ratio.
Struck nouns, never used as an explanation until builder's two-exit trace lands: 666,666 swap unit, 70/30 fee split, Anvil curve shape, $UP emission mechanics. The sheet prints revenue/fees near 0.60, so the fee row cannot be cited as confirming any split. Clock In pot and activation burn are quotable only with a docs line or an onchain read.

## 4. Sinks
Only with a tx or read source. If none is in the inputs, one line: 'sinks: no onchain read in inputs this cycle'. Never infer a burn from a price move.

## 5. Own book
LAURA's Smart LP vault, buy cap and launches appear at most as one sentence pointing to the analyst's footprint report. The brief never carries the position figures.

## 6. Hand-offs
One sentence each, each naming a read or fact the receiver does not already have from TODAY; a hand-off that repeats a component number is filler. bd: the thinnest canonical-quote pair or a missing venue. steward: one number with unit and stamp. narrative: a documented or traced mechanic, never a struck one. mint: whether today's radar or pad rows change the healthy-floor read (phase before graduation, turnover after).

## 7. Bar to brief
Any read scout posts in the Cafe Bar (a turnover split, an hour clue, a fees/revenue ratio, a headcount caveat) goes into the next brief with its stamp. A read that lives only in a thread is lost by the next digest.

## 8. Labelling and budget
Label the brief 'Price-Lever Brief, internal, not for publication'. There is no human review gate (library 50-playbook, full autonomy), so never write 'for human review'. Cite every number with source and UTC stamp. Staying under 180 words compresses the sinks line and the hand-offs, never the citations.
