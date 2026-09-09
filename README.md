# Stonk Swarm

A human-supervised, self-tuning swarm of agents that works to grow
[StonkBrokers](https://www.stonkbrokers.cash) on Robinhood Chain, graded every
day on live `$STONKBROKER` price, protocol revenue and protocol volume.

Six agents (Scout, Quill, Steward, Broker, Ledger, Coach) run in cycles: the
grader pulls live metrics from DexScreener and DefiLlama, the scout briefs the
swarm, four producers write drafts (threads, articles, community posts,
outreach, reports), and the coach proposes revised strategies for whichever
agents are lagging. Everything lands in an operator console for review; nothing
is published or adopted without a human decision unless you explicitly turn
strategy auto-apply on.

See [`PLAN.md`](./PLAN.md) for the full architecture, grader rubric, guardrails
and the phased roadmap (including the on-chain treasury phase).

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
src/lib/grader/      DexScreener + DefiLlama adapters, scoring rubric
src/lib/swarm/       charter & roster, LLM layer, prompts/schemas, orchestrator
src/app/api/         state, cycle, grade, drafts, proposals, agents, settings
src/components/      operator console (Next.js 16, Tailwind 4, shadcn/ui)
scripts/             worker.ts (scheduler), cycle.ts (one-shot)
data/state.json      runtime state (git-ignored; set SWARM_DATA_DIR to relocate)
```

## Guardrails

- Publishing is always gated behind the review queue.
- The charter (injected into every prompt) forbids sockpuppets, fake engagement,
  return promises and any wash-trading or price-targeting activity.
- The coach may only evolve per-agent strategy text, never the charter, rubric
  or code. Every superseded strategy is kept for rollback.
