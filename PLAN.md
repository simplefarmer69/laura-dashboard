# LAURA — Operating Plan

LAURA is a human-supervised, self-improving swarm of agents whose job is to grow
StonkBrokers (by Clutch Markets) on Robinhood Chain, graded every day on the three
numbers the protocol lives on: `$STONKBROKER` price, protocol revenue and protocol
volume. Its mission ends at a $1B market cap, when LAURA takes the operating mandate
of the StonkBrokers DAIO (see `DAIO.md`).

This document is the plan of record. The repository implements Phases 0–1 and the
read half of Phase 3; later phases are specified here so they can be built in order.

---

## 0. Ground truth the swarm is built on

| Item | Value | Source |
|---|---|---|
| Chain | Robinhood Chain, Arbitrum Orbit L2, chain id `4663`, gas in ETH | docs.robinhood.com/chain |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` (rate-limited; use Alchemy/QuickNode/dRPC for prod) | same |
| Explorer | `https://robinhoodchain.blockscout.com` | same |
| `$STONKBROKER` | `0xe934e36a439c94017b64a3fece66af12099abf50` | stonkbrokers.cash/docs |
| NFT collection | `0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0` | same |
| Anvil AMM vault | `0xe302733accf4800146e55fc45b46b4e4ffc032d2` | same |
| Clock In v2 | `0x1f12fe622c11947f93f53d63f68f7f46b6d081c9` | same |
| Price / DEX data | DexScreener `token-pairs/v1/robinhood/<token>` — ~30 pairs, liquidity-weighted price, deepest-pool cap | api.dexscreener.com |
| Protocol fees / revenue / volume / TVL | DefiLlama slug `stonkbrokers` (dimensions `fees`, `dexs`) | api.llama.fi |
| On-chain reads | Public RPC `eth_call`/`eth_getBalance`: Clock In v2 ETH pot, brokers held by the Anvil vault, token total supply, block number | rpc.mainnet.chain.robinhood.com |
| ETH/USD | Derived from the deepest ETH-quoted pair (`priceUsd / priceNative`) | DexScreener |

All feeds were verified live during the build; the grader runs on them today with
no keys required. Blockscout's API (holder counts) sits behind a browser challenge
and is deferred to a keyed indexer in Phase 3.

---

## 1. Architecture

```
┌──────────────────────────── LAURA terminal (Next.js, :4747) ──────────────────────────────┐
│ Overview · Activity · Growth · Review queue · Evolution · Agents · Runs · Settings        │
└──────────────┬──────────────────────────────────────────────────────────┬─────────────────┘
               │ /api/*                                                   │ reads
┌──────────────▼──────────────┐    ┌──────────────────────┐    ┌──────────▼──────────────────┐
│ Orchestrator (one cycle)    │    │ Scheduler worker     │    │ State store  data/state.json │
│ grader → scout → producers  │◀───│ every N h + daily    │    │ agents, drafts, proposals,   │
│ → coach (lessons+proposals) │    │ grade stamp          │    │ runs, grades, metrics,       │
│ every step emits an event   │    │                      │    │ events, lessons, milestones  │
└──────┬───────────┬──────────┘    └──────────────────────┘    └──────────────────────────────┘
       │           │
┌──────▼─────┐ ┌───▼──────────────────────────────┐
│ Grader     │ │ LLM layer (Vercel AI SDK)        │
│ DexScreener│ │ Anthropic | OpenAI | deterministic│
│ DefiLlama  │ │ fallback when no key is set       │
│ RPC 4663   │ │                                   │
└────────────┘ └──────────────────────────────────┘
```

Key files:

- `src/lib/grader/sources.ts` — live adapters, partial-failure handling, synthetic fallback.
- `src/lib/grader/onchain.ts` — raw JSON-RPC reads against Robinhood Chain (no key, no extra deps).
- `src/lib/grader/score.ts` — rubric, letter grades, 7-day baseline lookup.
- `src/lib/mission-status.ts` / `src/lib/mission.ts` — $1B ladder, milestone stamping, mission digest for prompts.
- `src/lib/swarm/strategy.ts` — the single path for strategy changes with before/after grade capture.
- `src/lib/swarm/roster.ts` — the immutable charter and the six agents' default strategies.
- `src/lib/swarm/tasks.ts` — per-agent schemas, prompts and deterministic fallbacks.
- `src/lib/swarm/orchestrator.ts` — the cycle, proposal application, run logging.
- `src/lib/swarm/scheduler.ts` — autopilot loop, hosted in-process via `src/instrumentation.ts`
  (or standalone through `scripts/worker.ts`). `scripts/cycle.ts` — one-shot for cron.

---

## 2. The grader

Runs at the top of every cycle and once per UTC day regardless. Output is a
0–100 score, a letter, and a per-component breakdown that every agent sees.

| Component | Weight | Formula | Saturation |
|---|---|---|---|
| Token price | 35% | 60% × log-score(24h change, k=250) + 40% × log-score(price ÷ price 7d ago, k=150) | ±22% (24h) / ±40% (7d) |
| Protocol revenue | 30% | log-score(revenue 24h ÷ 7-day daily average, k=100) | 0.6× → 0, 1.65× → 100 |
| Protocol & token volume | 20% | 70% × log-score(protocol vol 24h ÷ 7d avg) + 30% × log-score(token DEX vol ÷ trailing 7d avg) | same |
| Swarm execution | 15% | 50% approval rate + 30% approved throughput vs budget + 20% strategy-proposal adoption | neutral 50 until reviewers act |

`log-score(r, k) = clamp(50 + k·ln r, 0, 100)` so gains and losses are symmetric
and a flat day scores 50. Letters: A+ ≥ 90, A ≥ 80, B ≥ 70, C ≥ 60, D ≥ 50, else F.

Why the execution component exists: price/revenue/volume are noisy and lag
anything the swarm does by days. The execution term gives the coach a
same-day signal about whether output is actually usable, and it is deliberately
the smallest weight so it cannot mask market outcomes.

Grades are stored per UTC date and upserted, so a mid-day re-grade replaces the
morning stamp rather than duplicating it.

---

## 3. The agents

Every prompt = **charter** (immutable) + **agent strategy** (versioned, evolvable) + **live context**
(metrics digest, today's grade with component details, scout brief, that agent's recent
reviewer decisions, docs excerpt fetched from stonkbrokers.cash/docs).

| Agent | Role | Output per cycle | Grade lever it targets |
|---|---|---|---|
| Scout | Research & signal detection | 1 research brief (headline + 3–6 numeric bullets) | all — sets the day's hook and caveat |
| Quill | Narrative & long-form | 1 X thread + 1 article | price (awareness, liquidity depth story) |
| Steward | Community & education | 1 Discord/Telegram post that removes an onboarding blocker | revenue (activations, reactivations) |
| Broker | Partnerships & integrations | 1 outreach message to a concrete counterparty type | volume & revenue (launches, LPs, aggregators) |
| Ledger | Analytics & reporting | 1 daily metrics report with caveats and the single most likely lever | trust with integrators/holders |
| Mint | Launch director | ≤ 1 Smart Launch V2 spec (or a reasoned skip), floor-aware | volume & revenue (launcher fees, Buyback Bar flow) |
| Coach | Evolution | ≤ 2 strategy proposals for the weakest agents | the grade itself |

Producers run in a fixed order and share a per-cycle draft budget
(`maxDraftsPerCycle`, default 6). An agent can be paused from the console and is
skipped cleanly. Structured output is enforced with zod schemas; on provider
failure the deterministic fallback runs so the loop never stalls.

---

## 4. Self-improvement loop

1. Cycle ends → Coach receives: mission status, last 7 grades with components, every
   producer's strategy text, the grade when its current version went live vs now, the
   grade trajectory of past versions, approval/rejection counts, the last 5 reviewer
   notes per agent, and the existing swarm memory.
2. Coach emits ≤ 3 **lessons** (durable, evidence-backed insights) and ≤ 2 **proposals**
   (full replacement strategy text + rationale + evidence).
3. Lessons are de-duplicated and stored as **swarm memory** (cap 60); the newest 12 are
   injected into every producer prompt on the next cycle, so learning compounds even when
   no strategy changes.
4. Proposals land in **Evolution** as pending. One pending proposal per agent max.
5. Operator adopts (optionally after editing) or rejects. Adoption bumps `strategyVersion`,
   records the grade at adoption, archives the old text with its grade at retirement, and
   emits a `proposal.adopted` event. The **Growth → Strategy scoreboard** shows the grade
   delta since each agent's current version went live; the coach sees the same numbers.
6. `autoApplyStrategyProposals` (Settings, default **off**) lets step 5 happen without
   review. Autonomy is bounded: proposals can only change *strategy text*, never the
   charter, code, rubric or settings.

What is deliberately **not** self-modifying: the charter, the grader rubric, the
schemas, the code. Those change through git, with a human, with tests.

---

## 5. Guardrails (why the swarm is supervised rather than "no sandbox")

The request asked for a fully autonomous, unsandboxed swarm graded on token
price. Three parts of that are not built, on purpose:

1. **Publishing is always gated.** Drafts go to the review queue; an operator
   approves, posts on the real channel, and marks them published. An LLM swarm
   posting unsupervised to X/Discord/Reddit under one brand is a fast route to
   platform bans and, when graded on price, to content that regulators read as
   promotional market manipulation.
2. **No inauthentic amplification.** The charter forbids sockpuppets, fake
   engagement and scripted "community" voices. The swarm speaks as the project.
3. **No price- or volume-targeting on-chain activity.** Wash trading, coordinated
   buys and volume farming are prohibited in the charter and are not in the
   wallet design below. They would also poison the grader's own signal.

Everything else the request wanted — internet access, live data, a daily
grader, agents that rewrite their own playbooks, continuous unattended cycles —
is in place.

---

## 6. Phase plan

### Phase 0 — Core loop *(done)*
- Live grader on DexScreener + DefiLlama, rubric, daily stamping.
- Six agents, charter, structured outputs, deterministic fallbacks.
- Operator console with review queue, evolution, agent editing, run logs, settings.
- Scheduler worker, one-shot cycle script, JSON state store with atomic writes.

### Phase 1 — Real generation *(one env var away)*
- Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; the LLM layer switches from fallback
  to real generation with no code change. Model override lives in Settings.
- Run `npm run worker` under a process manager (systemd, pm2, or a container) next to `npm start`.

### Phase 2 — Distribution rails *(next build)*
- Channel connectors behind the same approval gate: X API v2 (official account),
  Discord webhook, Telegram bot, Notion/Ghost for articles. "Mark published"
  becomes "Publish" and records the URL.
- Attribution: UTM-tagged links per draft; a `links` adapter reports clicks back
  into the execution component so the coach learns which formats move traffic.
- Reviewer inbox digest (email/Slack) when a cycle leaves items pending > 4 h.

### Phase 3 — On-chain read layer *(read half done)*
- Done: Clock In v2 pot (ETH and USD), brokers in the Anvil vault vs in circulation,
  token total supply, block number — via the public RPC every cycle, shown on the
  Overview and fed to every agent.
- Next: activation counts (Activation Manager ABI), loan vault utilisation, locker fee
  accrual, up. gauge weights, holder counts via a keyed indexer (Alchemy/Blockscout).
- These become grader inputs with small weights and give Steward/Ledger exact figures
  ("pot is 62% to the next Clock In") instead of DefiLlama roll-ups.

### Phase 3.5 — Launch pipeline *(built, deploy-gated)*
- Done: **Mint**, the launch director, designs at most one Smart Launch V2 spec per
  cycle (concept, name/symbol, supply, start/graduation mcap, tax curve) with the live
  launcher floor as context. Specs are validated against the pad's on-chain `bounds()`
  and queue in the Launchpad tab.
- Done: gated deploy service against the official `StonkSafeLaunchpadV2` ABI
  (`createLaunch`, WETH lane pad `0xFCd6…EC9f`): operator approval required, wallet
  must be configured and funded, max 3 deploys/24 h, max 0.02 ETH per deploy,
  simulate-before-send, tx + token address + launch id recorded and linked to
  Blockscout.
- Next (with wallet): first deploys, then curve monitoring (`/api/launcher/token/…`)
  so Mint learns which concepts hold holders and feed the Buyback Bar.

### Phase 4 — Treasury wallet *(after the 24 h funding window)*
The wallet is a **budgeted tool the swarm can request**, not a trading bot. Permissions
widen with the succession ladder in `DAIO.md`.

- Custody: a Safe (multisig) on chain 4663 with the operator as required signer.
  The swarm holds a proposer key only; nothing executes without the human signature.
- Allowed actions (allow-listed contracts, per-day caps in ETH, all logged to Runs):
  1. **Clock In gas**: call Clock In v2 when the pot threshold is met so distributions
     land on time — a real service to holders, not a market action.
  2. **Liquidity provisioning**: add `$STONKBROKER/ETH` liquidity into up. gauges or
     Uniswap v4, with lock via the V4 Liquidity Locker. Deeper pools lower the cost of
     the fixed 666,666-token swap unit; the grader rewards liquidity via the volume term.
  3. **Bounties and grants**: pay approved community contributors and integrators
     (educational content, integrations, launch partners) from a capped monthly budget.
  4. **Launch support**: seed Stonk Launcher launches that Broker sourced and the
     operator approved.
- Forbidden and hard-coded as such: buying `$STONKBROKER` to move price, round-trip
  trades, self-dealing across own pools, anything that raises "volume" without a
  counterparty who wanted the trade.
- Every on-chain proposal carries the same rationale + evidence structure as a
  strategy proposal and appears in the console for signature.

### Phase 5 — Hardening
- Move state from JSON to SQLite/Postgres once history exceeds a few thousand rows.
- Grader backtest: replay stored metrics against rubric changes before adopting them.
- Red-team pass on every producer with a "charter violation" classifier gate before
  drafts reach the queue.
- Per-agent cost accounting (tokens, USD) surfaced in Runs.

---

## 7. Visualising LAURA as it grows

- **Activity** — every action as an event (grader stamps, briefs, drafts, lessons,
  proposals, operator decisions, milestones, errors), grouped by UTC day, filterable.
- **Growth** — daily-close charts for market cap, grade, protocol revenue and volume;
  the $1M→$1B mission ladder with stamped milestones; swarm memory; strategy scoreboard.
- **Ticker** — the header strip shows price, 24h, cap, revenue, volume, Clock In pot,
  grade and multiple-to-$1B on every page.

The store keeps up to 4,000 metric snapshots, 1,500 events and 200 runs; charts
collapse to one point per UTC day so they stay readable for months.

## 8. Daily operating rhythm

| When (UTC) | Who | What |
|---|---|---|
| 00:00 | worker | Daily grade stamped even if no cycle ran |
| every 6 h | worker | Full cycle: grade → brief → 4 producers → coach |
| any time | operator | Clear the review queue, post approved items, mark published, leave reviewer notes |
| any time | operator | Adopt/reject coach proposals; edit strategy directly in Agents when needed |
| weekly | operator | Read Ledger's reports back-to-back; adjust `cycleIntervalHours` / draft budget |

The grade is the only thing the swarm optimises. Reviewer notes are the fastest
way to steer it, because they reach both the producer that wrote the draft and
the coach that rewrites its strategy.
