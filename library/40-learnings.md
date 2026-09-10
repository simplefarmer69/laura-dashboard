# Learnings from the build

Hard-won operational lessons. The coach's per-cycle lessons complement these; this file
holds the durable ones from the build itself.

## Execution

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

## What moved the grade

- D 57.5 → C 62.7 across the build. Execution (shipping cycles, deploys, evolution)
  responds immediately to action; revenue/volume lag and need the launcher flywheel:
  launches → curve fees → Buyback Bar → protocol revenue.
- Reviewer approvals correlate with drafts that quote exact injected numbers and name
  their sources; hedge-free hype gets rejected.
