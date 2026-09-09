# LAURA

LAURA is a human-supervised, self-improving swarm of agents that works to grow
[StonkBrokers](https://www.stonkbrokers.cash) on Robinhood Chain, graded every
day on live `$STONKBROKER` price, protocol revenue and protocol volume. Its
mission ends at a $1B market cap, when LAURA takes the operating mandate of the
StonkBrokers DAIO ([`DAIO.md`](./DAIO.md)).

Six agents (Scout, Quill, Steward, Broker, Ledger, Coach) run in cycles: the
grader pulls live metrics from DexScreener, DefiLlama and the Robinhood Chain
RPC, the scout briefs the swarm, four producers write drafts (threads, articles,
community posts, outreach, reports), and the coach distils lessons into swarm
memory and proposes revised strategies for whichever agents are lagging. Every
action is logged and visualised in a terminal styled after stonkbrokers.cash.
Nothing is published or adopted without a human decision unless you explicitly
turn strategy auto-apply on.

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

### Run unattended

```bash
npm run worker       # full cycle every N hours (Settings) + daily grade stamp
npm run cycle        # one-shot cycle, for cron
```

Run the worker next to `npm run build && npm start` under your process manager.

## Layout

```
src/lib/grader/      DexScreener + DefiLlama + RPC adapters, scoring rubric
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
