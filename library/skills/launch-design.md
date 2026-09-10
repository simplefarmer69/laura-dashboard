---
name: launch-design
description: Use when designing a token launch spec for the Smart Launch V2 pad
agents: mint
---

# Launch design

A launch is a message with a curve attached. Humans in the community Telegram judge it
in two seconds from name + symbol + logo; the curve decides whether it survives an hour.

## Speaking via tokens

Launches are LAURA's voice. Every spec must fill the `message` field: the one statement
this launch makes to the audience watching new tokens appear in Telegram. Compose the
launch AS the message —

- **name** = the headline of the statement (evocative, reads at a glance);
- **symbol** = the punchy ticker version of it;
- **concept** = the broadcast body: written in LAURA's voice, addressed to the humans
  reading the feed, grounded in what is true right now (grade trajectory, milestones,
  live events, mission progress toward $1B).

Say something because it is worth saying: a milestone hit, a meaningful grade move, a
notable live event, a mission update. If you cannot state what the launch says in one
`message` sentence, it is spam — skip.

### Cadence

Speak regularly, never spammily: at most 1–2 speech launches per day. The code enforces
a 12h cooldown after the last deploy and the hard caps (3 deploys/24h, 0.02 ETH/deploy)
never bend. Before proposing, read WHAT LAURA HAS ALREADY SAID in your prompt — never
restate a message a recent launch already made; the coach's notebook records what was
said. A justified silence grades better than a repeated line.

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

The art direction is the "sentinel era": deep space-dark grounds, one neon accent,
an orbital ring behind the glyph, and the restyled LAURA signature — futuristic
guardianship, the future of humanity and security. Every logo renders procedurally
(deterministic, versioned; old launches keep their original art) and is the single
most-seen pixel of the launch.

Pick artMotif to fit the story, not at random: bell, chart, rocket, bull, clock, wave,
bolt, diamond, shield, moon, flame, crown, eye, star, key, globe, robot, plus the
sentinel-era motifs — sentinel (guardian shield with a watching core), orbit (planet
under guardianship rings), neural (a thinking bloom of nodes), beacon (a light that
warns and welcomes). Prefer a sentinel-era motif when the concept touches protection,
autonomy, AI, or the mission itself.

Pick artPalette the same way: emerald, amber, crimson, violet, cyan, gold, plus the
colder futuristic grounds — ion (electric blue) and aurora (teal). Cyan/ion/aurora read
as security and future-tech; gold/amber read as market ritual; crimson is for warnings.
LAURA's own identity mark is the cyan sentinel (shield + beacon-eye + orbital rings) —
tokens that speak AS LAURA herself should echo it (sentinel motif, cyan or aurora).

## Red flags — stop and skip

- Name/symbol resembles another project, person, or security
- Concept only works if price goes up
- You can't explain the token in one sentence
