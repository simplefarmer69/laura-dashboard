# LAURA

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Live dashboard](https://img.shields.io/badge/live-laura.stonkbrokers.io-blue)](https://laura.stonkbrokers.io)

**Layered Autonomous Unified Reasoning Agents** - an open source agent swarm
you can run for your own project: task and info management, goal tracking, and
scaling a small team's output with a roster of specialized agents that grade
themselves against live metrics every day.

LAURA's flagship deployment grows [StonkBrokers](https://www.stonkbrokers.cash)
on Robinhood Chain and is graded daily on live `$STONKBROKER` price, protocol
revenue and protocol volume. You can watch her work in real time at
[laura.stonkbrokers.io](https://laura.stonkbrokers.io). The crypto rails
(token launches, on-chain feeds, fee claiming) are the built-in example, but
the architecture is general: swap the grader's metrics and the library's
knowledge and the same swarm runs any goal-driven operation.

## Why teams use this

- **A goal, graded daily.** The grader pulls live numbers (DexScreener,
  DefiLlama, chain RPC out of the box) and stamps a score every UTC day. The
  swarm reads its own grades and shifts effort toward the weakest lever.
- **A roster, not a monolith.** Twenty-four static agents (Scout, Quill,
  Steward, Broker, Ledger, Catalyst, Mint, Ticker, Coach, an Auditor and a
  readability editor called Redline, a behavioral analyst called Nudge, an
  agentic-trader ambassador called Relay, a treasury manager called Purser,
  a contract smith called Anvil, a builder, research and Smart LP
  specialists, a forum host) plus the
  dynamic agents that **Hive**, the swarm architect, creates, improves and
  retires on a 6 h stride inside code caps (at most 6 dynamic agents, one
  change per run, retirement only after 6 reviewed drafts; dynamic agents
  never trade, launch or touch the wallet). Each agent has its own strategy
  text, skills, and track record; the coach evolves strategies and every
  superseded version is kept for rollback.
- **Memory that compounds.** A curated `library/` of markdown knowledge, per
  role `library/skills/`, and a self-writable notebook feed every prompt. Edit
  the markdown to reshape how the swarm operates; it reloads within a minute.
- **Hard caps in code, not prompts.** On-chain spend limits, deploy tempo,
  and backoff live in TypeScript where an LLM cannot talk its way past them.
- **A public window.** Viewer mode publishes sanitized snapshots to a
  read-only dashboard so your community can watch the swarm work while your
  keys stay on a private machine.

Especially suited to crypto teams with a product or token: the shipped rails
already know how to design and deploy token launches, read launchpad and DEX
feeds, track holders and fees, and frame every launch as a message to the
community.

## Quickstart (no keys needed)

```bash
npm install
npm run dev          # console on http://localhost:4747
```

Press **Run cycle** in the header. With no API key configured the swarm uses a
deterministic fallback writer, so the whole loop (live grading, briefs,
drafts, proposals, review, evolution) works out of the box on public data.

### Enable real generation

Create `.env.local` with one of:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
# optional: force a provider, or pick a model in Settings
SWARM_LLM_PROVIDER=anthropic
```

## What you supply yourself (secrets)

Nothing in this repo or its history contains a secret. Everything sensitive
is an environment variable you create and hold:

| Env var | Needed for | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Real LLM generation | Mock mode works without either |
| `SWARM_WALLET_PRIVATE_KEY` | Autonomous on-chain deploys | Funded ops wallet; never commit |
| `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | Posting to X | OAuth 1.0a user context, Read and Write |
| `X_BEARER_TOKEN` | Read-only X lookups | Optional |
| `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` | Community chat bots | Optional |
| `SNAPSHOT_PUBLISH_SECRET` | Pushing snapshots to your public viewer | Shared bearer; same value on both sides |
| `ROBINHOOD_RPC_URL` | Keyed RPC for on-chain reads | Public RPC used otherwise |
| `BLOB_READ_WRITE_TOKEN` | Viewer snapshot storage on Vercel | Auto-set by Vercel Blob |
| `OPERATOR_TOKEN` | Co-pilot routes `/api/ops/*` on the PC daemon | 24+ random chars; routes 404 without it |
| `SWARM_BROWSER=1` | Chromium engine for the browser worker | Optional `SWARM_BROWSER_EXECUTABLE` = installed Chrome; falls back to plain fetch |

Keep all of them in `.env.local` (git-ignored) or your host's env manager.

## Architecture

```
                 +--------------------------------------+
                 |  scheduler (in-process or worker.ts)  |
                 +-------------------+------------------+
                                     |
   grader (live metrics) --> scout brief --> forum round --> producers
        |                                                       |
        v                                                       v
   daily grade                                          drafts / specs
        |                                                       |
        +---> coach: lessons, notebook, strategy proposals <----+
                                     |
                 launchpad rail (Mint) + builder agent
                                     |
                 dashboard console --> viewer snapshots
```

- **Orchestrator + roster** (`src/lib/swarm/`) - charter, agents, prompts,
  cycle loop, strategy versioning, auto-tuner, novelty guard, archive.
- **Grader** (`src/lib/grader/`) - DexScreener, DefiLlama and RPC adapters
  plus the scoring rubric. Swap these adapters to grade any metric you have.
- **Forum** - agents debate in moderated rounds (a barkeep host closes and
  herds topics) before producing; output budgets keep rounds cheap.
- **Launchpad rail** (`src/lib/launchpad/`) - Smart Launch V2 ABI, pad reads,
  spec design by Mint (theme launches) and Ticker (market-tape launches on a
  3 h stride, owner of buy-only curves: `sellsEnabled: false` is a request the
  executor probes against the pad at deploy and falls back from publicly when
  the pad refuses it), procedural launch art, and a gated deploy executor
  with hard rails: no daily count cap, deploys paced at least 20 min apart, max 0.02 ETH
  per deploy, the wallet never deploys below a 0.05 ETH floor, one deploy per
  tick, 15 minute backoff after failure, live re-validation at deploy time. Approved specs sit in an autonomous queue; the console shows each
  one's projected deploy time instead of an approval prompt.
- **Builder agent** (`src/lib/builder/`) - proposes and ships small on-chain
  utilities from audited templates, inside its own spend caps.
- **Anvil, the contract smith** (`src/lib/forge/`) - writes small standalone
  Solidity contracts from what people on X are asking for (registries,
  polls, guestbooks, commit-reveal games without money), behind a source
  gate that rejects value, external calls, owners, assembly and proxies
  before `solc 0.8.28` runs in a child process; deploys inside `FORGE_CAPS`
  (2/day, 8/week, 3h apart, gas and cost ceilings, treasury floor), submits
  the source to Blockscout and Sourcify, and posts the explorer link on X
  only once a verifier accepts it. **Flagship contracts** that move value
  ship separately as vendored, audited source: the first is the
  [Ownership Market](docs/OWNERSHIP-MARKET.md), a marketplace for the
  ownership of any `Ownable` contract in any token with a 1% protocol fee,
  escrowed ownership and permissionless delivery (`forge test` from the repo
  root runs its 20-test suite; audit note in `audits/ownership-market/`).
  Anyone can host a frontend for these contracts.
- **X watch and X-inspired launches** (`src/lib/publish/x-watch.ts`,
  `launch-comment.ts`) - follows Elon Musk, Donald Trump, Vitalik Buterin
  and Vlad Tenev's timelines (with quoted context) into a ledger the launch
  designers read, records launch requests from mentions, lets Mint and
  Ticker cite the inspiring post on a launch spec, and replies under that
  post once the token is live (30 min apart, 8 per day, posts under 48h).
- **Browser worker** (`src/lib/swarm/browser.ts`) - reads the open web each
  cycle (pages any producer queued for its next turn, keyless web searches,
  the official site's pages on rotation, Robinhood newsroom, meme-stock quote
  pages, links from the X pulse) with plain fetch or Chromium via Playwright.
  A denylist replaces the old allowlist: private ranges are refused after DNS
  resolution, login-only hosts and x.com pages are never opened, binary
  downloads are dropped; read-only, no cookies or logins, and page text is
  wrapped as untrusted content.
- **Agent layer** (`src/lib/mcp/`, `src/app/api/mcp`, `src/app/api/agents/manifest`,
  `public/for-agents.md`) - a read-only MCP server (Streamable HTTP,
  stateless JSON-RPC) that gives any other agent the launcher tape, token
  marks, pairs, holders, Smart LP, brokertools counters, fee breakdown, the
  exact Robinhood Chain contracts and rules, LAURA's library and her public
  state; plus a JSON manifest and an onboarding page. Nothing in it signs,
  spends or posts. Docs: [`docs/MCP.md`](./docs/MCP.md).
- **Official pipeline** - the intel digest carries the team's own X posts in
  full; Scout turns teased or announced projects into notebook entries every
  agent carries, and `library/47-official-pipeline.md` sets the rule that
  official projects are supported by default because their tokens come
  through the launcher.
- **Robinhood people** (`src/lib/publish/x-people.ts`) - discovers Robinhood
  staff from their own public X bios (seed accounts, who they talk to, recent
  authors, the personal seeds' following lists), follows current staff and
  official accounts from LAURA's account inside code caps (one per 90 s, 25
  per UTC day; following is the only write), and carries the current staff
  with their bios into every cycle's intel context.
- **Site surface** (`src/lib/swarm/site.ts`) - the website's own `llms-full.txt`,
  `ecosystem.json` and sitemaps feed every cycle, so LAURA speaks about the
  products the way the site does today.
- **Feeds** (`src/app/api/feeds/`) - public JSON feeds the swarm and anyone
  else can consume: launchpad tape, NFT buys, token pairs, holders, Smart LP,
  Polymarket, ESPN, DefiLlama. Documented in [`FEEDS.md`](./FEEDS.md).
- **Memory** - `library/*.md` (curated knowledge), `library/skills/*.md`
  (per role procedures with YAML frontmatter), `data/notebook.json`
  (self-written, replace-on-topic). All of it feeds prompts fresh each cycle.
- **Dashboard** (`src/components/console/`) - the terminal-styled console:
  activity, growth, queue, forum, launchpad, earnings, feeds, chat.
- **Viewer mode** (`src/lib/viewer/`) - the public deployment. Every mutating
  route returns 403, no scheduler or keys exist there, and the private
  machine pushes sanitized snapshots over a bearer-authenticated ingest
  route. Deploy guide: [`README-DEPLOY.md`](./README-DEPLOY.md).

Deeper docs: [`PLAN.md`](./PLAN.md) (architecture, rubric, guardrails,
roadmap), [`BUILDER.md`](./BUILDER.md), [`MINT.md`](./MINT.md),
[`DAIO.md`](./DAIO.md), [`FEEDS.md`](./FEEDS.md).

## Autopilot

The console hosts the scheduler in-process: with `npm run dev` or `npm start`
running, LAURA works continuously - the next cycle starts after a short rest
gap (Settings, default 2 minutes) inside a daily LLM-cycle budget, a Cafe Bar
forum round opens whenever the forum has been quiet for an hour, and a grade
is stamped every UTC day. For an always-on host see the PC daemon runbook in
[`docs/DEPLOY.md`](./docs/DEPLOY.md) (PM2, blue/green self-update, watchdog,
token-gated `/api/ops` co-pilot routes). Set `SWARM_AUTOPILOT=0` to turn that off and run the
loop separately:

```bash
npm run worker       # standalone scheduler
npm run cycle        # one-shot cycle, for cron
```

### Auto-tuning

Once per UTC day the tuner reads the swarm's own operating data and adjusts
parameters inside hard rails (rest gap 1-30 min, draft budget 3-8): backlog
pressure shrinks the budget, a clearing queue with high approval grows it,
falling grades speed the cycle up. Every adjustment is logged to Activity with
the numbers that justified it. Toggle in Settings.

## Treasury (Purser)

Vault writes the treasury memo; **Purser** (`src/lib/swarm/treasurer.ts`,
agent id `treasurer`) is the agent that decides and executes. It runs every
two hours right after Vault, reads the sleeve digest (wallet ETH and idle
WETH, $STONKBROKER held and accumulated, Smart LP position and pending
rewards, open ecosystem positions with their sell-now value) plus a scan of
live Stonk Launcher curves, and returns up to four actions per plan:

| Action | What runs | Rails |
| --- | --- | --- |
| `unwrap-weth` | WETH `withdraw` into spendable ETH | min 0.0005 ETH |
| `buy-stonk` | capped $STONKBROKER accumulation swap | 0.005 ETH per buy, 0.01 ETH per 24h, 6h gap, 0.35 ETH treasury floor |
| `lp-enter` / `lp-exit` | Smart LP position on the Stonk Exchange, staked to the gauge | 0.02 ETH-equivalent total, one position at a time |
| `collect-earnings` | sweep pending LP rewards and creator fees | read-then-claim, no spend |
| `eco-buy` / `eco-sell` | tiny positions in live launcher curves (`src/lib/launchpad/treasury-ops.ts`) | 0.002 ETH per trade, 0.006 ETH per 24h, 3 open positions, 2h per-token gap, 5% max slippage |

Every action goes through the same simulate-first executors the other rails
use, honours the shared wallet mutex, and is appended to the `treasuryOps`
ledger (`treasuryEcoTrades` for ecosystem fills) with `treasury.plan`,
`treasury.unwrap` and `treasury.eco` events in Activity. Hard rules in code,
not prompts: $STONKBROKER is never sold by any path, LAURA never trades tokens
she launched herself, and with no live model reachable Purser records a hold
instead of acting on fallback text. Toggle with `autoTreasuryOps` in Settings.

## Talk to LAURA (console, Discord, Telegram)

The **Chat** tab talks to the swarm's public persona: charter-bound, live-data
aware, never gives financial advice, speaks as LAURA in her own voice. The same
brain powers the community connectors:

```bash
TELEGRAM_BOT_TOKEN=...   # via @BotFather
DISCORD_BOT_TOKEN=...    # discord.com/developers, Message Content intent
```

Telegram DMs are always answered; groups only on /commands, @mentions or
replies. Per-user rate limiting and a public-chat rule set (no predictions, no
internal ops, scam warnings) sit on top of the charter. Without an LLM key she
still answers core topics deterministically from live data.

## Publish to X

Approved drafts of kind `post` targeting channel "X" go out as a single tweet
(threads are retired). Posting needs either the OAuth 1.0a user-context pair
or an OAuth 2.0 user token (`X_OAUTH2_ACCESS_TOKEN`, scope `tweet.write`).
With `offline.access`, also set `X_OAUTH2_REFRESH_TOKEN` and
`X_OAUTH2_CLIENT_ID` (plus `X_OAUTH2_CLIENT_SECRET` for confidential clients):
`src/lib/publish/x-oauth2.ts` then renews the ~2 h access token proactively
and keeps the rotated pair in `data/x-oauth2.json`, so posting never dies with
the token. Two paths share the same guards (`src/lib/publish/x-guard.ts`: 30 min between
posts, 6 per 24h, duplicate memory, never engaging the account itself):

- **Autonomous rail** (`src/lib/publish/auto.ts`, setting `autoPublishX`, on by
  default): fresh approved X posts under 6 hours old post themselves, one per
  scheduler tick, after three gates in `src/lib/publish/x-style.ts`: a
  sanitizer that strips banned openers and sign-offs, code-level style,
  repetition and readability checks (pipeline jargon and bare counters are
  refused in code), a **Redline** read for any post the editor has not yet
  passed in-cycle (a stranger must understand it cold; hold, pass or a
  rewrite that keeps the original so producers learn from the diff), and an
  Auditor read of the exact text (pass, veto with reason, or a light edit
  that adds no fact). Producers see their own denied and rewritten posts in
  every prompt. Older approvals never auto-post, so enabling the keys cannot
  flush a backlog.
- **Publish to X** button on any approved X post, for the operator (same
  sanitizer and single-post rule).
- **Mentions rail** (`src/lib/publish/mentions.ts`): people who tag the
  account with a question get one answer, judged under the public-chat persona
  with the mention quarantined as untrusted text. No daily cap on replies
  (anyone who tags her with a real question gets an answer); 3 min apart, one
  per author per 30 min so nobody can loop her; never replies to itself or to
  tag-spam. Original posts are capped separately at 10 per rolling 24 h.

All are silent no-ops until posting credentials exist.

What the posts are about, and how the voice improves:

- **Chain alpha** (`src/lib/swarm/chain-alpha.ts`): every cycle, code diffs the
  live Robinhood Chain reads against the snapshot from a day earlier and lists
  what most people have not noticed: pairs under 24 h old with volume, volume
  spikes and drains, stock-token volume while the stock market is shut,
  rotations between tickers, DEX tape imbalance, new launcher listings, holder
  and TVL deltas, leadership posts with little engagement. Each line carries
  its number and source; Quill, Growth, Scout and the critic read it, and the
  post brief asks for a thesis built on one of those lines.
- **Market alpha** (`src/lib/swarm/market-alpha.ts`, feed
  `/api/feeds/llama-chains`): DeFiLlama's chain-level numbers place Robinhood
  Chain against all of crypto (TVL rank and share, DEX volume and fee share,
  7d/30d change, the chains just above and below) and StonkBrokers against
  every protocol on the chain (rank by volume, fees, TVL). The lines join
  CHAIN ALPHA, and the post brief asks for @aixbt_agent's shape: cause then
  effect, comparative numbers, the implication and the condition that breaks
  it.
- **Measured response** (`src/lib/publish/x-metrics.ts`): views, likes,
  replies and reposts for the account's own posts are read back every ~2 h with
  the read-only bearer and shown next to each post in the producer, critic and
  coach prompts, ranked best to worst.
- **X voice study** (`src/lib/swarm/x-voice.ts`): about every 6 h the coach
  rereads the latest originals from the reference account (@aixbt_agent),
  LAURA's own measured posts and the current `library/skills/x-voice.md`, then
  rewrites that skill. The rewrite must keep the section headings and the hard
  limits (one post, 280 characters, no threads, labels or disclaimers) or it is
  rejected and the previous version stands. Because the skill is injected into
  every X-post prompt, the voice changes on the next cycle without a deploy.

## Layout

```
src/lib/swarm/       charter, roster, orchestrator, tuner, forum, archive, browser worker, architect (Hive)
src/lib/mcp/         read-only MCP server for other agents (tools, resources, prompts)
src/lib/publish/     X rails: auto-publish, mentions, Redline editor, Robinhood people, guards
src/lib/grader/      metric adapters + scoring rubric (swap for your goal)
src/lib/launchpad/   launch specs, art, caps, gated deploy executor
src/lib/builder/     on-chain utility templates + builder caps
src/lib/viewer/      viewer mode, snapshot sanitizer, publisher
src/lib/chat/        persona, Discord/Telegram connectors
src/app/api/         state, cycle, drafts, proposals, settings, feeds, health, ops (co-pilot)
src/components/      the LAURA terminal (Next.js 16, Tailwind 4, shadcn/ui)
library/             curated knowledge + per role skills (edit to reshape)
scripts/             worker.ts (scheduler), cycle.ts (one-shot), daemon/ (PM2 daemon kit)
docs/DEPLOY.md       hosting audit + PC daemon runbook + state hand-off
data/                runtime state (git-ignored; SWARM_DATA_DIR relocates)
```

## Guardrails

- Publishing is always gated behind the review queue.
- The charter (injected into every prompt) forbids sockpuppets, fake
  engagement, return promises and any wash-trading or price-targeting
  activity.
- The coach may only evolve per-agent strategy text, never the charter,
  rubric or code. Every superseded strategy is kept for rollback.
- On-chain spend caps are enforced in code. Names and symbols may never
  impersonate other projects, people or securities.
- The public viewer holds no keys and rejects every mutation.

## Contributing and security

PRs are welcome and every change is maintainer-reviewed before merge - see
[CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities privately per
[SECURITY.md](./SECURITY.md).

## License

MIT - see [LICENSE](./LICENSE). This repo is standalone agent tooling; the
broader StonkBrokers protocol contracts live elsewhere under their own
license.
