# Builder: token utility playbook

The builder agent gives LAURA's own launched tokens real function after launch.
It designs at most ONE utility project about every third cycle, and only for
tokens LAURA launched herself (deployed, at least 24h old, not already served).

## The four allowlisted builds (nothing else exists)

- **faucet-drip** (on-chain): deploys the audited ownerless `FaucetDrip`
  template and funds it with a tiny acquired bag of the token. Anyone can claim
  a capped drip on an interval. Requires an acquisition.
- **burn-pledge** (on-chain): deploys the audited ownerless `BurnPledge`
  template. Holders burn tokens to write a permanent on-chain pledge line.
  No acquisition needed.
- **holder-leaderboard** (dashboard): a viewer surface ranking holders. No
  chain action; ships directly from swarm state.
- **gated-lore** (dashboard): a lore page whose full text renders only for
  holders. No chain action.

Custom contracts are impossible by construction: the executor deploys only the
two solc artifacts baked into the repo (`src/lib/builder/artifacts.json`).
Both templates are ownerless, proxy-free, and hold no privileged paths.

## Hard caps (code, not judgment; BUILDER_CAPS)

- Acquisitions: max 0.002 ETH per buy, 0.004 ETH per rolling 24h, 12h minimum
  gap, never below the 0.35 ETH treasury floor, 5% slippage guard.
- Projects: max 2 in flight, ONE per token ever, max 2 template deploys per
  rolling 7 days.
- Faucet funding is clamped server-side so the bag covers 20 to 1000 claims
  regardless of what the design says.
- Env overrides can only SHRINK these numbers, never raise them.

## Approval and execution flow

1. Builder proposes a `UtilityProject` (pending) in its cycle step.
2. It approves through the normal review queue: operator PATCH on
   `/api/utility/[id]`, or the autonomy sweep when full autonomy is on.
3. Dashboard-kind projects ship on the next scheduler tick with zero spend.
4. Chain-kind projects additionally require the operator's
   `autoExecuteUtility` setting (default OFF). The executor performs at most
   one chain action per tick: first the bag acquisition (if wanted), then the
   template deploy on a later tick. Simulate-first, receipt-checked, 30 minute
   backoff on failure, project fails after 3 consecutive errors (slot freed).

## Acquisition venues

- Token still on the WETH-lane curve: pad `buy()` paid in WETH.
- Token bonded into a pool: SwapRouter02 `exactInputSingle` paid in native ETH,
  best of the 1% and 0.3% fee tiers.
- STONK-lane tokens still on their curve wait until they bond (the ETH caps
  only map cleanly onto ETH venues).

Charter rule 8 sanctions these tiny capped buys solely to fund holder
utilities. They are never price support and never wash trading; framing them
as market action in any output is a charter violation.
