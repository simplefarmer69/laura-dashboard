# Learnings from the build

Hard-won operational lessons. The coach's per-cycle lessons complement these; this file
holds the durable ones from the build itself.

## Execution

- **A "successful" transaction is not a live product.** Launches #276/#277 deployed
  clean (receipts, logos, floor listing) yet never went live: `createLaunch` only
  registers — the supply must be approved and `arm`ed to start the sale clock. The
  operator caught it ("I don't see the tokens live") before the swarm did. Rule: after
  any on-chain action, verify the **user-visible end state** (phase live, clock
  running), not the transaction receipt. The executor now arms on deploy and runs a
  repair pass for deployed-but-unarmed launches every tick.

- **Verify the exact surface the UI renders from, not just any API that returns
  "live".** (2026-09-10, follow-up to the #276/#277 scare.) When the operator said the
  tokens were "launched external to the v2 stonklauncher launchpad", the reflex was to
  hunt for a different V2 contract. Reverse-engineering the live bundle + a headless
  render of /launcher proved the opposite: our weth2 pad IS the UI's default ETH lane,
  and both tokens render on the floor with logos and Quick Trade — the invisibility
  the operator saw was the ~30-minute deployed-but-unarmed window (phase `waiting`,
  buried under 110 other waiting rows). Method that settled it: (1) find the endpoint
  the UI client actually fetches (`/api/safe-launch/floor`), (2) find the pad the UI's
  create flow writes (`e$ = XJ.find(key === "weth2")` in the bundle), (3) render the
  page headless and screenshot the token cards. The executor now has a verify pass
  (`launch.verified` event) that closes the loop from tx receipt to pixels-on-screen.

- **First real deploys succeeded autonomously** (2026-09-10, ~90s after wallet funding):
  two launches, two logo attaches, zero human clicks, total spend ~0.00023 ETH. The
  fail-closed pattern (simulate → cap-check → send → verify receipt → brand) works;
  keep it for every on-chain action.
- One deploy per scheduler tick + 15-minute backoff after failure prevents both wallet
  drain and retry storms. Deploy queue orders by priority desc, then oldest first.
- Deduplicate launch concepts by symbol AND lowercase name against every non-rejected
  launch — the model happily re-proposes yesterday's idea ("Opening Bell" twice).
- Anti-snipe pattern that read well: decaying start tax (2500 bps → −250/min) with a
  long buffer (900s) so humans can read the concept before trading opens.

## Working with the LLM

- Tight zod string caps cause AI_NoObjectGeneratedError; set generous caps and add a
  one-shot repair retry that feeds the validation error + raw output back. After this,
  fallback usage dropped to zero.
- Models invent dates. Pin `TODAY (UTC): <date>` at the top of producer prompts.
- Mint reasons well about the launcher floor when given live grid rows; give agents
  real data, not summaries, whenever the token budget allows.

## Infrastructure

- Machine capacity guard (defer cycle when 1-min load > cores or free mem < 300MB)
  keeps the swarm inside its box; deferred cycles retry next tick, nothing is lost.
- Hung fetches wedge UI state forever without `AbortSignal.timeout(...)` — every fetch
  gets one.
- Reverse-engineering the site's client JS bundle (grep for endpoint strings) yielded
  the exact logo/profile signature formats when docs didn't cover them. Verify a wire
  format live (the content-addressed upload can be tested walletless) before building
  on it.
- `tsx -e` can't do top-level await or relative imports from /tmp; use a script file
  in the repo with absolute imports and `--tsconfig`.

## Deep memory (LAURA's storage architecture)

- **Three memory tiers.** (1) Hot state: `data/state.json`, capped arrays (runs 200,
  events 1500, lessons 60, notebook 150 topics) so the console stays fast. (2) Durable
  archive: an append-only SQLite DB at `data/archive/archive.db` — every run, draft,
  grade, event, lesson, proposal, launch, brief, milestone, metrics snapshot and
  notebook revision is upserted there on every state save, BEFORE the hot caps evict
  anything. Nothing LAURA produces is ever lost; topic-replaced notebook entries keep
  every prior revision. (3) Curated library: these markdown files, injected each cycle.
- **Retrieval** (`src/lib/swarm/archive.ts`): `recentOutputs(agentId, n)` returns an
  agent's own past drafts beyond the hot window; `searchArchive(text, n)` is FTS5
  full-text search across all streams; `gradeHistory(n)` and `notebookHistory(topic)`
  read deep history. Also exposed at `GET /api/archive` (`?q=`, `?agent=`, `?grades=`,
  `?notebook=`) with bare `GET /api/archive` returning storage health (row counts, DB
  size, last backup).
- **Backups**: every 6h a save triggers timestamped copies of state.json +
  notebook.json into `data/backups/` (newest 14 kept), so a corrupted hot file is a
  one-file restore, not amnesia.
- **Prompt digest fix**: `libraryDigest` now budgets per section — the self-authored
  notebook and skill index always survive the 14KB cap (previously the docs alone
  overflowed it and the notebook never reached a single prompt). When writing long
  library docs, remember the docs section absorbs truncation from the end: durable
  facts belong in earlier-numbered files.

## Self-improvement toolkit (code-backed, current)

- **Price trend in prompts.** Every agent's METRICS block now includes a price/liquidity
  trend digest computed from stored snapshots (6h/24h/3d/7d windows, history depth, and
  when the grader's 7d baseline unlocks). Price is the weakest lever — use these numbers
  instead of reasoning from a single 24h move. Reads only; no trading exists anywhere.
- **Cycle telemetry.** Each run records LLM calls, mock fallbacks and schema repairs;
  the coach sees them as OPERATIONAL HEALTH and the console Runs panel shows them.
- **Watchdog.** Two consecutive failed cycles push a `swarm.health` event so breakage is
  visible in the console instead of silent in logs.
- **Skill self-editing.** The coach may rewrite one skill file per cycle (constrained to
  `/library/skills`, 16-file cap, never code or caps) — operating procedures now evolve
  with evidence, like strategies do.

## What moved the grade

- D 57.5 → C 62.7 across the build. Execution (shipping cycles, deploys, evolution)
  responds immediately to action; revenue/volume lag and need the launcher flywheel:
  launches → curve fees → Buyback Bar → protocol revenue.
- Reviewer approvals correlate with drafts that quote exact injected numbers and name
  their sources; hedge-free hype gets rejected.
