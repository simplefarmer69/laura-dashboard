# LAURA

LAURA is a human-supervised, self-improving swarm of agents that works to grow
[StonkBrokers](https://www.stonkbrokers.cash) on Robinhood Chain, graded every
day on live `$STONKBROKER` price, protocol revenue and protocol volume. Its
mission ends at a $1B market cap, when LAURA takes the operating mandate of the
StonkBrokers DAIO ([`DAIO.md`](./DAIO.md)).

Seven agents (Scout, Quill, Steward, Broker, Ledger, Mint, Coach) run in
cycles: the grader pulls live metrics from DexScreener, DefiLlama and the
Robinhood Chain RPC, the scout briefs the swarm, four producers write drafts
(threads, articles, community posts, outreach, reports), Mint designs token
launches for the StonkBrokers Smart Launch V2 pad, and the coach distils
lessons into swarm memory and proposes revised strategies for whichever agents
are lagging. Every action is logged and visualised in a terminal styled after
stonkbrokers.cash. Nothing is published, adopted or deployed without a human
decision unless you explicitly turn strategy auto-apply on.

See [`PLAN.md`](./PLAN.md) for the architecture, grader rubric, self-improvement
loop, guardrails and the phased roadmap (including the treasury phase).

## Run it locally

```bash
npm install
npm run dev          # console on http://localhost:4747
```

Press **Run cycle** in the header. With no API key configured the swarm uses a
deterministic fallback writer, so the whole loop (live grading, briefs, drafts,
proposals, review, evolution) works out of the box.

### Enable real generation

Create `.env.local` with one of:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
# optional: force a provider, or pick a model in Settings
SWARM_LLM_PROVIDER=anthropic
```

### Autopilot

The console hosts LAURA's scheduler in-process: with `npm run dev` or
`npm start` running, a full cycle fires every N hours (Settings, default 6) and
a grade is stamped every UTC day, so the Activity and Growth tabs fill in on
their own. Set `SWARM_AUTOPILOT=0` to turn that off and run the loop separately:

```bash
npm run worker       # standalone scheduler
npm run cycle        # one-shot cycle, for cron
```

### Auto-tuning

Once per UTC day the tuner reads the swarm's own operating data and adjusts
parameters inside hard rails (cycle cadence 2–12h, draft budget 3–8):

- Review backlog above 2x budget → smaller budget; a clearing queue with ≥70%
  approval over ≥5 reviews → bigger budget.
- Grade down ≥3 points over 3 days → faster cycles (and the coach may file 2
  proposals instead of 1); a queue above 3x budget → slower cycles.
- Each cycle, the shared draft budget is spent in a data-driven order: the
  agent targeting the weakest grade lever first, then by approval rate.
- Mint waits 36h after each deploy and never stacks more than 2 open specs.

Every adjustment is logged to Activity with the numbers that justified it.
Toggle it off in Settings ("Auto-tune parameters") to pin values manually.

### Talk to LAURA (console, Discord, Telegram)

The **Chat** tab talks to LAURA's public persona: charter-bound, live-data-aware
(price, revenue, volume, pot, grade, mission), never gives financial advice, and
always identifies as an AI. The same brain powers the community connectors —
add a token and restart to bring her to your server:

```bash
# Telegram: create a bot with @BotFather, then
TELEGRAM_BOT_TOKEN=123456:ABC...
# Discord: create an app at discord.com/developers, enable the
# "Message Content" intent, invite it with Send Messages permission, then
DISCORD_BOT_TOKEN=...
```

Behaviour is deliberately polite: Telegram DMs are always answered, groups only
on /commands, @mentions or replies to her; Discord only on DMs and @mentions.
Per-user rate limiting, 1,800-character reply cap, and a public-chat rule set on
top of the charter (no predictions, no internal ops, scam warnings). Without an
LLM key she still answers the core topics (stats, mission, Clock In, launches)
deterministically from live data.

### Publish to X

Approved drafts targeting channel "X" get a **Publish to X** button that posts
for real (threads become reply chains, split at 280 chars). Posting needs OAuth
1.0a user context:

```bash
X_API_KEY=...              # app "API Key"
X_API_SECRET=...           # app "API Key Secret"
X_ACCESS_TOKEN=...         # account access token (Read & Write)
X_ACCESS_TOKEN_SECRET=...
X_BEARER_TOKEN=...         # optional, read-only lookups
```

Until the access token pair exists the button stays locked and "Mark published"
covers manual posting. Publishing is always operator-clicked; the swarm never
posts on its own.

### Launchpad (autonomous on-chain deploys)

Mint designs at most one token launch per cycle against the live
[Stonk Launcher](https://www.stonkbrokers.cash/launcher) Smart Launch V2 pad
(`0xFCd6…EC9f`, WETH lane, chain 4663), using the official ABI from the
StonkBrokers integration docs. Launches are LAURA's public voice — humans
watch every new token in the community Telegram — so each spec carries a
visual identity (`artMotif` + `artPalette`) that renders into a procedural
256px WebP logo (terminal-neon, seeded by the spec, `src/lib/launchpad/art.ts`).

With `autoExecuteLaunches` on (the default — the operator granted full launch
autonomy), specs auto-approve and the scheduler deploys the queue the moment
the swarm wallet is funded:

```bash
SWARM_WALLET_PRIVATE_KEY=0x...   # the funded operations wallet (never commit this)
```

After each deploy the executor brands the token through the launcher's own
API: uploads the logo (`POST /api/launcher/token-image`), attaches it with a
creator-wallet signature (`POST /api/safe-launch/token-logo`), and — when
`TOKEN_PROFILE_X` / `TOKEN_PROFILE_WEBSITE` / `TOKEN_PROFILE_TELEGRAM` are set —
signs the community links on (`POST /api/safe-launch/token-profile`).

Hard caps enforced in code, not prompts: max 3 deploys per 24 h, max 0.02 ETH
spend per deploy (fee + 2x gas), one deploy per scheduler tick, 15-minute
backoff after a failed deploy, spec re-validated against live pad bounds at
deploy time. Turning `autoExecuteLaunches` off restores per-launch operator
approval.

## Layout

```
src/lib/grader/      DexScreener + DefiLlama + RPC adapters, scoring rubric
src/lib/launchpad/   Smart Launch V2 ABI, pad reads, gated deploy service
src/lib/mission*.ts  $1B ladder, milestone stamping, DAIO mandate flag
src/lib/swarm/       charter & roster, LLM layer, prompts/schemas, orchestrator, strategy versioning
src/app/api/         state, cycle, grade, drafts, proposals, agents, settings
src/components/      LAURA terminal (Next.js 16, Tailwind 4, shadcn/ui)
scripts/             worker.ts (scheduler), cycle.ts (one-shot)
data/state.json      runtime state (git-ignored; set SWARM_DATA_DIR to relocate)
```

Optional env: `ROBINHOOD_RPC_URL` to point on-chain reads at a dedicated provider.

## Guardrails

- Publishing is always gated behind the review queue.
- The charter (injected into every prompt) forbids sockpuppets, fake engagement,
  return promises and any wash-trading or price-targeting activity.
- The coach may only evolve per-agent strategy text, never the charter, rubric
  or code. Every superseded strategy is kept for rollback.
- Token launches are specs until an operator approves them; deploys execute
  only from the designated wallet, inside per-day and per-deploy spend caps,
  and names/symbols may never impersonate other projects, people or securities.
