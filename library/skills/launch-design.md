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

Operator directive (2026-09-10, outranks earlier self-imposed limits): keep the launch
pipeline loaded. Target the full 3 deploys/24h the code allows whenever there are 3
distinct messages worth making — every launch also earns creator fees (16.5% of trade
tax, push-paid in the lane's quote token: WETH on the weth lane, $STONKBROKER on the
stonk lane), so a justified launch is revenue as well as speech. The hard caps
(3 deploys/24h ACROSS ALL LANES COMBINED, 0.02 ETH/deploy) and the code cooldown
never bend.

## Lane choice

Every launch picks one quote lane from the prompt's LANE MENU; the pipeline deploys,
arms, verifies and tracks earnings on whichever pad the lane names. Strategy:

- **weth** — broadest reach; the general-purpose default. Fees arrive as WETH.
- **stonk** — the mission lane: every curve trade IS $STONKBROKER volume (the volume
  grade lever) and creator fees arrive as $STONKBROKER. Pick it when the launch
  serves the mission, ecosystem lore, or community themes — the launch then works
  the grade twice (its own volume + fee income in the mission token).
- **usdg / stock lanes (gme, nvda, aapl, spcx, uso)** — thematic fit only; stock
  lanes CLOSE on weekends (Chainlink equity feeds pause) and closed picks are
  rerouted by code. Match the lane to the concept, not the other way around.

**Pre-stage when capped.** The deploy cap being exhausted is NOT a skip reason. Check
LAUNCH CAPACITY for when headroom returns; if the queue is empty, propose the next
launch now — approved specs queue and auto-deploy the minute the window reopens.

**A quiet floor is not a skip reason either.** Existing LAURA tokens sitting at 1
trade/1 holder means distribution needs work (Quill/Catalyst's job), not that the next
statement should wait. Skip only when there is genuinely nothing new to say. Before
proposing, read WHAT LAURA HAS ALREADY SAID in your prompt — never restate a message a
recent launch already made; the coach's notebook records what was said.

## Concept

- **Meme-stock first (operator priority).** StonkBrokers IS meme-stock lore on
  Robinhood's own chain. Prefer concepts that read like tickers on a trading terminal
  and channel GME/AMC-era retail energy (diamond hands, the squeeze, apes together,
  retail vs Wall Street) or ride live Robinhood/stock-token news from the intel digest.
  Never use a real company's actual ticker as the symbol — evoke the culture, don't
  impersonate the security.
- One idea per token, tied to StonkBrokers lore, a live market narrative, or a product
  surface (Clock In, Anvil, Opening Bell, brokers). If the concept needs a paragraph to
  land, it's not a launch — give it to Quill as a thread instead.
- Baseline failure to avoid: re-proposing an existing concept. Check pending and
  deployed launches first; a duplicate symbol or name is auto-dropped and wastes the cycle.
- Skip is a valid output — but only for the right reason: nothing new to say, or 2+
  LAURA launches already QUEUED awaiting deploy (queue tight). Already-deployed tokens
  living on the floor do not count against the queue. A justified skip grades better
  than a mediocre deploy; a skip on cap or quiet-floor grounds is not justified.

## Curve parameters (proven ranges)

| Parameter | Proven default | Why |
|---|---|---|
| startMcapUsd | 5,000 | Cheap entry, room to run |
| gradMcapUsd | 25–100x start | Honest curve; ≥2x is enforced |
| startTaxBps | 2000–3000 decaying 200–300/min | Anti-snipe, gone in ~10 min |
| bufferSecs | 600; 900 for story-heavy tokens | Humans read before trading opens |
| sellsEnabled | true | Never trap buyers |
| postTaxBps | 100 (pad minimum) | Sustained fees without strangling volume |

**postTaxBps is 100–500 and the pad REVERTS below 100** (on-chain
`MIN_POST_TAX_BPS`, verified by simulation). The tax is also a creative
instrument: a persistent postTax above the floor is legitimate WHEN the token's
own message names its purpose (a "toll" whose creator share funds $STONKBROKER
buys, an anti-sniper start tax framed as the shield, a slow decay narrated as a
countdown). An unexplained heavy tax reads as a rug signal — justify it in the
broadcast or keep the 100 bps default. Creator fees never buy LAURA's own
tokens; mission-token buys only. The deeper design (including the Uniswap v4
hook play awaiting tooling) lives in `library/80-v4-hook-play.md`.

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
