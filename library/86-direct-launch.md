# Direct launch rail (shipped 2026-10-02)

Operator directive: "allow LAURA to simply launch tokens including tax tokens with
interesting airdrop rewards features from the taxes, launching directly on-chain and
seeding single sided LP outside of the Stonklauncher, as well as tokens on Pons."

Two new venues sit next to the Smart Launch V2 pad. Mint designs for them in a
separate "Direct launch" step (4h stride) and a separate executor deploys them. Code
lives in `src/lib/direct-launch/`.

## Venue "direct": LauraTaxToken + single-sided vDEX seed

LAURA deploys her own ERC20 (`LauraTaxToken`, fixed source in
`direct-launch/contract.ts`, Solidity 0.8.28, verified on Blockscout/Sourcify after
deploy) and seeds the WHOLE supply into a vDEX concentrated-liquidity pool against
WETH. No curve, no graduation: the token trades from the first second.

Deploy sequence (`deployDirectLaunch`, five transactions, one launch per executor tick):

1. deploy token: supply minted to the swarm wallet, treasury = wallet;
2. `clFactory.createPool(token, WETH, 200, sqrtPriceX96)` (tick spacing 200 = 0.3%
   fee; an existing pool is reused), initialized one tick outside the range on the
   token side so the first buyer sets the first price;
3. `token.markPool(pool, positionManager)`: starts the tax decay clock, excludes the
   pool and the NPM from holder rewards, exempts the NPM from tax;
4. `approve` + `positionManager.mint` of the whole supply as a single-sided range from
   `startMcapUsd` to `rangeTopMcapUsd` (100 bps amount tolerance, deadline from the
   chain head, not the wall clock);
5. `token.finalize()`: burns the owner key. Nothing is upgradable afterwards.

The LP NFT stays in the swarm wallet (fee claim). The range math is exact bigint
tick math (`direct-launch/tick-math.ts`); `singleSidedRange` handles both token
orderings. A tight range is deep liquidity; a wide range is a long runway.

### Tax mechanics (and why buys only)

A CL pool checks exact inbound amounts in its swap callback, so a token that taxes
transfers INTO the pool breaks every sell. The tax is therefore applied to **buys
only** (`from == pool`, recipient not exempt). Sells are never taxed.

- Starts at `startTaxBps` (max 5000), loses `decayBpsPerMinute` each minute from
  `markPool` until `floorTaxBps` (max 500). Spec validation requires the window
  `(start - floor) / decay` to be 5 to 180 minutes; a zero-tax direct launch is refused
  (that is what the pad is for).
- Each tax is paid in the token and split by bps of the tax: `holderShareBps` to the
  holder-reward accumulator, `burnShareBps` burned (max 5000), remainder to the
  treasury. If no one is reward-eligible yet, the holder share goes to the treasury
  instead of being lost. Conservation verified exactly on a fork.
- Holder rewards are a dividend accumulator (`magnifiedRewardPerShare`,
  corrections on transfer). `claim()` for yourself or `claimFor(address[])` for anyone:
  the airdrop is permissionless, so LAURA or any community member can push rewards to
  the whole holder list.
- `rewardMode` 0 "steady": rewards simply accrue. `rewardMode` 1 "diamond": any send or
  sell forfeits the sender's unclaimed rewards to everyone else. The message must say
  which mode the token uses.
- Read-side: `currentTaxBps`, `secondsUntilFloor`, `eligibleSupply`,
  `totalRewardsDistributed`, `totalBurned`, `totalTreasuryTax`,
  `withdrawableRewardOf`.

Fork-tested (anvil fork of Robinhood Chain): deploy, pool, markPool, whole-supply mint,
finalize; buys taxed exactly, decay 2000 to 1000 bps over 10 min, rewards accrue,
sells succeed, `claimFor` pays out, diamond mode forfeits on sell, both token orderings.

## Venue "pons": Pons V2 factory

`launchOnPons` calls factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (chain 4663)
with launch config 0: supply 1B, curve fee 100 bps, phantom quote 1.68 ETH, graduation
at 4.2 ETH, tick spacing 200. Facts read live before every launch via `ponsStatus()`:
the factory must be open for the LAURA wallet, launch fee is exactly 0.0005 ETH,
`maxCreatorTaxBps` 1000. `creatorTaxBps` (max 1000) accrues to the LAURA wallet as
creator fee recipient. Optional `devBuyEth` (cap 0.002) buys on the curve in the same
executor pass with 3% slippage against the simulated output; the deployer is exempt
from the snipe tax. Token page: `https://www.ponsfamily.com/launchpad/<token>`.

## Caps (`DIRECT_LAUNCH_CAPS`, both venues together, fail closed)

| Cap | Value |
|---|---|
| maxPerDay / maxPerWeek | 2 / 7 |
| minGapHours | 4 |
| maxQueued (approved or deploying) | 2 |
| maxEthPerLaunch (fees + dev buy + gas) | 0.004 |
| maxDevBuyEth (Pons) | 0.002 |
| treasuryFloorEth | 0.35 |
| maxDeployCostEth (direct, whole five-tx sequence) | 0.005 |

Robinhood Chain gas is ~0.032 gwei, so a real direct deploy costs about 0.0001 ETH; the
cap is ~40x headroom and refuses deploys during a fee spike.

## Pipeline

- **Mint step "Direct launch"** (orchestrator, after the pad step): strided 4h from the
  last `direct.proposed` event or last attempt; skipped when the queue holds
  `maxQueued`. Reads `ponsStatus()` and live ETH/USD, generates a `directLaunchSchema`
  spec, validates (`directSpecProblem`, Pons closed, duplicate across pad + direct
  rails, reserved launcher needles), then `enqueueDirectLaunch` (auto-approved under
  `autoExecuteLaunches`, art generated like pad launches).
- **Executor** (`runDirectLaunchExecutor`, scheduler, between cycles): one launch per
  tick, wallet floor check, chain-work label `direct:<id>`, progress patched into the
  record after every transaction so a deployed token address is never lost. Failure
  returns the spec to `approved` with a 20 min backoff unless the token already exists.
  Direct tokens are verified afterwards (Blockscout then Sourcify, up to 8 attempts,
  10 min backoff). Events: `direct.proposed`, `direct.deployed`, `direct.verified`,
  `direct.failed`.
- Records live in `state.directLaunches` (merged by id), are included in the public
  viewer snapshot, and share the launch image route
  `/api/launches/<id>/image`.

## Disclosure doctrine (unchanged, charter-bound)

A direct launch gives LAURA the treasury share of every tax and the LP fee NFT. The
message must state the tax shape and where it goes in plain words; an unexplained heavy
tax reads as a rug signal and is forbidden regardless of caps. LAURA never buys her own
direct tokens; the Pons dev buy is a disclosed opening buy, capped.

## History

The 2026-09-11 note here described a BYO-ERC20-into-the-pad route blocked on "no
ERC20 bytecode in this runtime". The solc pipeline (`compileSource`) removed that
blocker; the direct rail above supersedes the plan. Pad findings from then still
hold: `sellsEnabled=false` and `openEnded=false` revert on all V2 pads; `eoaOnly`,
`maxBuyPpm`, `bondVenue 1`, `unsoldMode 1` are accepted.
