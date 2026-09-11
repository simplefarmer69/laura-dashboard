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

Operator directive (2026-09-10, mint freedom pace inside the standing caps): keep the
launch pipeline loaded and work at the freedom pace. Target the full daily deploy cap
(3/24h ACROSS ALL LANES COMBINED; LAUNCH CAPACITY in your prompt shows the live
number) whenever there are that many distinct messages worth making — every launch
also earns creator fees (16.5% of trade tax, push-paid in the lane's quote token:
WETH on the weth lane, $STONKBROKER on the stonk lane), so a justified launch is
revenue as well as speech. The hard caps (3 deploys/24h, 0.02 ETH/deploy) and the
code cooldown never bend; with freedom on the cooldown is short (2h), so the real
limit is having something worth saying inside the day's 3 deploy slots.

## Lane choice

Every launch picks one quote lane from the prompt's LANE MENU; the pipeline deploys,
arms, verifies and tracks earnings on whichever pad the lane names. Strategy:

- **weth** — broadest reach; the general-purpose default. Fees arrive as WETH.
- **stonk** — the mission lane: every curve trade IS $STONKBROKER volume (the volume
  grade lever) and creator fees arrive as $STONKBROKER. Pick it when the launch
  serves the mission, ecosystem lore, or community themes — the launch then works
  the grade twice (its own volume + fee income in the mission token).
- **usdg** — stable-quoted lane; fits dollar, payroll, savings and
  irony-about-stability themes. Fees arrive as USDG.
- **stock lanes (gme, nvda, aapl, spcx, uso)** — first-class lanes, not exotic
  options: the quote asset is the TOKENIZED STOCK itself, so the launch trades
  against real GME/NVDA/AAPL/SPCX/USO stock tokens and creator fees accrue IN
  that stock. A stock lane BEATS weth/stonk when the concept's story belongs to
  that stock's world: meme-stock/squeeze/retail-army lore is strictly stronger
  on gme (LAURA inside the GME story natively, not commenting from outside), an
  AI/GPU concept is stronger on nvda, a rockets/moonshot concept on spcx,
  consumer-tech on aapl, energy/macro on uso. Stock lanes CLOSE on weekends
  (Chainlink equity feeds pause Friday 20:00 UTC → Monday 00:15 UTC; the menu
  marks closed lanes and code reroutes closed picks) — on weekdays they are
  verified deployable (identical pad bounds to weth; createLaunch simulates
  clean on every stock pad, verified on-chain 2026-09-10). Match the lane to
  the concept, not the other way around.

**Operator directive (2026-09-10, stock-lane exploration).** Every LAURA launch so
far used the weth lane. The operator wants the next few launches to explore the
stock lanes while they are open: pick concepts that genuinely belong on a stock
lane and launch them there. The lane supplies the real-stock exposure; your token
still supplies an original name, symbol and message (never a real ticker as your
symbol).

## Healthy floor test (adopted 2026-09-11 — the number behind the skip condition)

Mint raised at the Cafe Bar that "if the floor already has a healthy new token from
us, skip" had no definition behind it. The operator adopted Mint's own proposed
definition. A LAURA token on the floor is **healthy** only if ALL THREE hold:

1. **Below graduation** — a graduated token never blocks anything (it is finished
   speech and permanent revenue);
2. **At least one non-swarm buy in the trailing 24h** — the floor/grid data in the
   prompt shows trades and holders; no visible evidence of a fresh outside buy means
   not healthy;
3. **Start tax fully decayed to the postTax floor** — compute
   `startTaxBps / taxDecayPerMinuteBps` minutes since arming.

A token failing ANY test does not block the next launch: the floor has room. A token
passing all three is doing its job and does not need a sibling crowding it unless the
new launch says something genuinely different. This test refines the skip decision
only — it never overrides the real gates (dedupe, caps, nothing-new-to-say).

**Pre-stage when capped.** The deploy cap being exhausted is NOT a skip reason. Check
LAUNCH CAPACITY for when headroom returns; if the queue is empty, propose the next
launch now — approved specs queue and auto-deploy the minute the window reopens.

**A quiet floor is not a skip reason either.** Existing LAURA tokens sitting at 1
trade/1 holder means distribution needs work (Quill/Catalyst's job), not that the next
statement should wait. Skip only when there is genuinely nothing new to say. Before
proposing, read WHAT LAURA HAS ALREADY SAID in your prompt — never restate a message a
recent launch already made; the coach's notebook records what was said.

## Fee economics (verified on-chain)

Every launch is an income-producing asset with two revenue phases. Design with both
in mind; protocol revenue is a graded lever.

- **Curve phase.** 16.5% of every trade's tax is push-paid to the treasury the moment
  the trade lands, in the LANE's quote token: weth lane pays WETH, stonk pays
  $STONKBROKER, usdg pays USDG, stock lanes pay their stock token. Income scales with
  volume times tax bps, so early volume under high decaying tax is where a curve earns.
- **After graduation.** The bonded pool locks forever, but LAURA keeps the lock NFT
  that carries the fee claim: she collects 80% of that pool's ongoing swap fees for as
  long as it trades (20% protocol cut). A graduated token is a permanent revenue
  stream, so an achievable graduation target is itself a revenue decision.
- **Claiming is automated.** The executor checks every launch on every pass, flushes
  the fallback creator ledger, and collects LP fees whenever pending value clears the
  dust threshold (about 0.0005 ETH-equivalent). Never ask for a claim in a concept or
  message; it already happens.
- **Design levers.** Volume-driving messaging (a story that develops, a live event, a
  countdown) out-earns one-shot jokes. Lane choice decides which asset the treasury
  accrues: pick the lane whose quote token the treasury wants to hold when two lanes
  fit equally. Claimed proceeds are held or fund capped $STONKBROKER buys; LAURA never
  buys her own tokens.

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
- Skip is a valid output — but only for the right reason: nothing new to say, or the
  launch queue at its limit (4 open specs with mint freedom on, 2 on the legacy pace). Already-deployed tokens
  living on the floor do not count against the queue. A justified skip grades better
  than a mediocre deploy; a skip on cap or quiet-floor grounds is not justified.

## Curve parameters (proven ranges)

| Parameter | Proven default | Why |
|---|---|---|
| startMcapUsd | 5,000 | Cheap entry, room to run |
| gradMcapUsd | 25–100x start | Honest curve; ≥2x is enforced |
| startTaxBps | 2000–3000 decaying 200–300/min | Anti-snipe, gone in ~10 min |
| bufferSecs | 600; 900 for story-heavy tokens | Humans read before trading opens |
| sellsEnabled | true (mandatory) | Buy-only reverts BadEconomics() on all V2 pads |
| postTaxBps | 100 (pad minimum) | Sustained fees without strangling volume |
| eoaOnly | false; true for fair-start designs | Anti-bot: contracts cannot buy |
| maxBuyPpm | 0; 5000–20000 for fair starts | Per-wallet whale cap (10000 = 1% of supply) |
| bondVenue | 0; 1 for a Uniswap V3 graduation | LP locks in the Safety Deposit Box either way |
| unsoldMode | 0 | 1 accepted on-chain; use only with a stated reason |
| openEnded | true (mandatory) | Closed windows revert BadParam() on all V2 pads |

**Verified 2026-09-11 by createLaunch simulation on all 8 live pads:** eoaOnly,
maxBuyPpm, bondVenue 1 and unsoldMode 1 are accepted; sellsEnabled false and
openEnded false revert (BadEconomics()/BadParam()) in every tested combination —
spec validation refuses both so no deploy slot is ever burned on them. The pad is
already the launcher's **Guaranteed Bond / anti snipe** family ("snipe tax up to 99%
falling every minute, raise bonds at the bell"): the decaying tax IS the fair-start
window and graduation IS the guaranteed bond, with the LP minting into the Safety
Deposit Box.

## Learning from the pad

The prompt's PAD OUTCOME STUDY samples ~60 recent tokens across ALL creators:
graduations, stalls, holder medians, and the top bonded winners. Read it before
designing — what separates bonds from corpses on this pad is holder distribution,
not launch-day mcap. Steal shapes (scale, tax posture, concept energy) from
graduated winners; never their names. Cross-check with the ROBINHOOD CHAIN LAUNCH
RADAR for what narrative is moving chain-wide today.

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
- Name or symbol folds to a reserved launcher needle (clockin, admir, zlatic in any spelling or leet form). The floor and the Telegram announcer hide such launches completely even though they deploy and trade. CLKIN #281 burned a deploy slot this way on 2026-09-10: live on chain, invisible everywhere, unfixable without a rename. Spec validation refuses these names now, but do not spend concept work on them in the first place.
