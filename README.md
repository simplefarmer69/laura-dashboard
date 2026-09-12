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
- **A roster, not a monolith.** Seven core agents (Scout, Quill, Steward,
  Broker, Ledger, Mint, Coach) plus a builder and a forum host, each with its
  own strategy text, skills, and track record. The coach evolves strategies;
  every superseded version is kept for rollback.
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
  spec design, procedural launch art, and a gated deploy executor with hard
  rails: no daily count cap, deploys paced at least 20 min apart, max 0.02 ETH
  per deploy, the wallet never deploys below a 0.05 ETH floor, one deploy per
  tick, 15 minute backoff after failure, live re-validation at deploy time. Approved specs sit in an autonomous queue; the console shows each
  one's projected deploy time instead of an approval prompt.
- **Builder agent** (`src/lib/builder/`) - proposes and ships small on-chain
  utilities from audited templates, inside its own spend caps.
- **Browser worker** (`src/lib/swarm/browser.ts`) - reads allowlisted web
  pages each cycle (pages agents asked for, the official site's pages on
  rotation, Robinhood newsroom, meme-stock quote pages, links from the X pulse)
  with plain fetch or Chromium via Playwright; read-only, no cookies or logins,
  and page text is wrapped as untrusted content.
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
  sanitizer that strips banned openers and sign-offs, code-level style and
  repetition checks against the account's own timeline, and an Auditor read
  of the exact text (pass, veto with reason, or a light edit that adds no
  fact). Older approvals never auto-post, so enabling the keys cannot flush a
  backlog.
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
src/lib/swarm/       charter, roster, orchestrator, tuner, forum, archive, browser worker
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
