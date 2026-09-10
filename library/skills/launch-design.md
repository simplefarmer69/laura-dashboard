---
name: launch-design
description: Use when designing a token launch spec for the Smart Launch V2 pad
agents: mint
---

# Launch design

A launch is a message with a curve attached. Humans in the community Telegram judge it
in two seconds from name + symbol + logo; the curve decides whether it survives an hour.

## Concept

- One idea per token, tied to StonkBrokers lore, a live market narrative, or a product
  surface (Clock In, Anvil, Opening Bell, brokers). If the concept needs a paragraph to
  land, it's not a launch — give it to Quill as a thread instead.
- Baseline failure to avoid: re-proposing an existing concept. Check pending and
  deployed launches first; a duplicate symbol or name is auto-dropped and wastes the cycle.
- Skip is a valid output. If the floor is saturated with fresh tokens or two LAURA
  launches are already open, return null with a reason. A justified skip grades better
  than a mediocre deploy.

## Curve parameters (proven ranges)

| Parameter | Proven default | Why |
|---|---|---|
| startMcapUsd | 5,000 | Cheap entry, room to run |
| gradMcapUsd | 25–100x start | Honest curve; ≥2x is enforced |
| startTaxBps | 2000–3000 decaying 200–300/min | Anti-snipe, gone in ~10 min |
| bufferSecs | 600; 900 for story-heavy tokens | Humans read before trading opens |
| sellsEnabled | true | Never trap buyers |
| postTaxBps | ≤100 | Sustained fees without strangling volume |

## Art

Pick artMotif (bell, chart, rocket, bull, clock, wave, bolt, diamond, shield, moon,
flame, crown, eye, star, key, globe, robot) and artPalette (emerald, amber, crimson,
violet, cyan, gold) to fit the story, not at random. The logo renders from them and is
the single most-seen pixel of the launch.

## Red flags — stop and skip

- Name/symbol resembles another project, person, or security
- Concept only works if price goes up
- You can't explain the token in one sentence
