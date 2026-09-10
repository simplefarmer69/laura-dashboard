# Builder agent (token utility engineering)

The builder is the swarm agent that gives LAURA's launched tokens post-launch
utility: it watches the tokens she has deployed through Smart Launch,
sometimes acquires a very small bag of one, and ships one of four allowlisted
utility builds for it. This document is the operator reference; the agent-facing
playbook lives in `library/45-builder.md`.

## What it does

1. **Watches LAURA's tokens.** Candidates come from `state.launches` (deployed,
   with a token address and on-chain launch id), enriched with trade counts and
   graduation/bond status from the treasury launch intel. A token must be at
   least 24h old and never previously served.
2. **Designs one project at a time.** A bespoke orchestrator step (strided to
   roughly every third cycle) asks the LLM for at most ONE `UtilityProject`
   against the candidate list. Anything not matching a candidate address is
   dropped. Kinds:
   - `faucet-drip`: deploy the ownerless FaucetDrip template, fund it with a
     tiny acquired bag; anyone claims a capped drip on an interval.
   - `burn-pledge`: deploy the ownerless BurnPledge template; holders burn
     tokens to write a permanent pledge line on-chain.
   - `holder-leaderboard` / `gated-lore`: dashboard-only surfaces built from
     swarm state; zero chain actions.
3. **Routes through the review queue.** Projects are created `pending` and
   approve exactly like launches: the operator PATCHes
   `/api/utility/[id]` with `{"action":"approve"}` (or `reject`), or the
   full-autonomy sweep approves them when `autoApproveProposals` is on.
4. **Executes on the scheduler tick.** `runBuilderTick` (wired after the
   smart LP tick) ships approved dashboard kinds immediately (no spend). Chain
   kinds run only while `settings.autoExecuteUtility` is true, one chain action
   per tick: acquisition first (when the project wants a bag), template deploy
   on a later tick. Everything is simulate-first with receipt verification,
   a 30 minute failure backoff, and automatic project failure (slot freed)
   after 3 consecutive errors.

## Hard caps (BUILDER_CAPS in src/lib/builder/caps.ts)

| Cap | Value |
| --- | --- |
| Max ETH per acquisition | 0.002 |
| Max ETH per rolling 24h | 0.004 |
| Min gap between acquisitions | 12h |
| Treasury floor (never spend below) | 0.35 ETH |
| Slippage guard | 5% |
| Active projects in flight | 2 |
| Projects per token, ever | 1 |
| Template deploys per rolling 7d | 2 |
| Min token age before serving | 24h |
| Faucet runway clamp | 20 to 1000 claims |

Caps are code, not judgment, and fail closed. Env overrides can only SHRINK
them:

- `BUILDER_MAX_ETH_PER_ACQ`
- `BUILDER_MAX_ETH_PER_24H`
- `BUILDER_MIN_ACQ_GAP_HOURS` (can only raise the gap)
- `BUILDER_MAX_ACTIVE_PROJECTS`
- `BUILDER_MAX_DEPLOYS_PER_WEEK`

## Contract templates

`src/lib/builder/contracts/` holds the two Solidity sources; the executor
deploys the pre-compiled solc 0.8.28 artifacts baked into
`src/lib/builder/artifacts.json` (the VM never compiles). Both are ownerless
and proxy-free with no privileged paths:

- **FaucetDrip**: immutable token, claim amount and interval fixed at deploy;
  anyone claims once per interval per wallet; anyone can top it up; no owner,
  no sweep, no pause.
- **BurnPledge**: immutable token; `pledge(amount, message)` transfers tokens
  to the dead address and stores the pledge line; append-only public log.

## Acquisition venues

- Curve (WETH lane, not yet bonded): pad `buy()` paid from the wallet's WETH
  (creator fee earnings).
- Bonded pool: SwapRouter02 `exactInputSingle` paid in native ETH, quoting the
  1% and 0.3% fee tiers and taking the best.
- STONK-lane curve tokens wait until they bond into a pool.

## VM operator activation

The agent appears in the roster automatically (DEFAULT_AGENTS merge by id) and
proposes projects on its stride with no configuration. To let approved chain
builds actually execute:

1. Set `autoExecuteUtility` to `true` in the swarm settings (it defaults to
   false; the console settings API or a direct state edit both work). Dashboard
   kinds ship regardless of this flag since they spend nothing.
2. Optionally shrink caps via the env vars above (VM env only).
3. The wallet key stays `SWARM_WALLET_PRIVATE_KEY` in VM env, as with every
   other executor. Nothing in this repo or the viewer deployment ever holds it.

Public viewer: `utilityProjects` and the `autoExecuteUtility` flag ride the
published snapshot whitelist, so the dashboard roster and event feed show the
builder with no dashboard-side changes.
