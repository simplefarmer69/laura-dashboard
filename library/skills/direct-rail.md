---
name: direct-rail
description: Use when designing a launch for the direct rail (own tax token seeded single-sided on the vDEX) or for Pons, outside the Smart Launch pad
agents: mint
---

# Direct rail

The pad is a curve with a bond at the end. The direct rail is a token that trades on
the vDEX from the first second, and Pons is someone else's curve with LAURA as
creator. Use them for statements the pad cannot make: a tax that pays holders, a token
whose whole supply is visibly in one pool, a presence on another launchpad's floor.
Full mechanics and caps: `library/86-direct-launch.md`.

## Pick the venue by the message

- **direct** when the economics ARE the message: holder rewards funded by the buy
  tax, a burn share, a diamond-hands rule, a supply sitting entirely in a visible
  range. The buyer's story must be tellable in one sentence: "buy, hold, get paid from
  everyone who buys after you".
- **pons** when the message is about reach: LAURA showing up on the Pons floor with a
  concept that belongs to that community, earning a creator tax (max 1000 bps). The
  curve shape is fixed by Pons (1B supply, 4.2 ETH graduation), so the whole design
  effort goes into name, symbol, concept and the disclosed opening buy.
- Skip when the DIRECT CAPACITY block in your prompt is closed, Pons is reported
  closed and the idea only works there, or the idea is a pad idea (plain curve, no
  reward feature). A pad idea on the direct rail wastes the 4h slot.

## Direct design rules

- Buys are taxed, sells never (pool physics, not a choice). Never promise a sell tax.
- `startTaxBps` max 5000 decaying to `floorTaxBps` max 500; the window must be 5 to
  180 minutes. Say the shape in the message: "20% falling to 2% over 18 minutes".
- Split the tax on purpose: `holderShareBps` (the airdrop/reward feature) plus
  `burnShareBps` (max 5000) plus the remainder to LAURA. A token whose message is
  "rewards for holders" should put most of the tax there (6000+); a token about
  scarcity leans on burn. Disclose LAURA's share in plain words.
- `rewardMode` "steady" for a savings story, "diamond" for a loyalty story (selling or
  sending forfeits unclaimed rewards to the rest). Name the mode in the message.
- Rewards are claimable by anyone for anyone (`claimFor`): the airdrop needs no admin,
  and the admin key is burned at deploy. Say so; it is the trust argument.
- Scale: `startMcapUsd` $500 to $200k, `rangeTopMcapUsd` at least 4x start. Tight
  range = deep liquidity for a trading token; wide range = long runway for a story
  token. The first buyer sets the first price, so start where you want them to.
- Supply 1e6 to 1e12; round numbers read better on the pool page.

## Pons design rules

- `creatorTaxBps` 0 to 1000; justify anything above 300 in the concept.
- `devBuyEth` 0 to 0.002: an opening buy is a signal, not a position. LAURA never buys
  her own tokens beyond this disclosed amount.
- The launch fee (0.0005 ETH) and config are read live; if the prompt says Pons is
  closed, do not propose a Pons spec.

## Shared hard rules

Original non-deceptive names; no reserved launcher needles; no duplicate of any pad or
direct launch; a real `message`; both rails together are capped at 2 per day, 7 per
week, 4h apart, 2 queued. Caps are code and never bend.
