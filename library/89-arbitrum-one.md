# Arbitrum One: LAURA's second launch chain (operator directive 2026-09-15)

## Summary (load-bearing)

On 2026-09-15 the operator directed: give LAURA the StonkBrokers Arbitrum One
launcher and Smart LP deployment data, bridge 1 ETH of treasury funds onto
Arbitrum One, and let her start deploying tokens there as part of the swarm.

StonkBrokers' Smart Launch V2 pads and the SafeLaunch lens are deployed on
Arbitrum One (chain 42161) with the same ABI as Robinhood Chain. Twenty-one
quote lanes are live there (WETH, USDC, ARB, WBTC, USDT, GMX, PENDLE, PEAR,
APE, BOOP, and eleven Reality Protocol r-stock quotes). Every pad read
`launchFeeWei() == 0` on 2026-09-15 (open). LAURA's deploy lane is `arbweth`
(WETH/native ETH), pad `0x9540AC4173E5A8c7970743bd13aEc5E9e97FcD22`, lens
`0x7376f9dC6432434D611488CB3E852071ed29E276`, WETH
`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`. Post-bond pools are Uniswap v3
(1% fee) locked liquidity — there is no StonkUp locker on Arbitrum.

Robinhood Chain itself settles to Arbitrum One, so the same EOA
(`SWARM_WALLET_PRIVATE_KEY`) is the wallet on both chains. Gas on Arbitrum is
a fraction of a cent; a `createLaunch` + `arm` costs well under 0.0001 ETH.

## Why Relay, not the Orbit bridge

The canonical L3→L2 path (ArbSys.withdrawEth + Outbox claim) takes days
through the challenge window — useless for funding a launch lane today.
Relay (relay.link) is an intent bridge that lists Robinhood Chain (id 4663,
deposits enabled) and Arbitrum One (42161). One deposit transaction on the
origin chain, a solver fills on the destination in seconds. A 1 ETH quote on
2026-09-15 returned ~0.9986 ETH out (~14 bps all-in). Caps refuse any quote
above 50 bps of fees.

## What the swarm does with it

- **Mint / Ticker** see `arbweth` in the lane menu. Roughly one launch in
  four should land there while the Arbitrum wallet is funded — concepts
  about Arbitrum, L2 culture, cross-chain reach, or pulling Arbitrum DeFi
  users toward StonkBrokers. An unfunded `arbweth` pick resolves to `weth`
  (Robinhood) so a launch is never stranded.
- **Executor** pays create/arm gas from the Arbitrum balance. Below the
  0.003 ETH foreign-chain gas floor the launch stays queued with words
  (Purser's `bridge-arb` is the top-up rail).
- **Purser** may `bridge-arb` only while Arbitrum holds under 0.02 ETH,
  ≤0.05 ETH per bridge, ≤0.1 ETH per 7 days, Relay fee ≤50 bps, Robinhood
  floor 0.35 ETH kept. The operator-directed 1 ETH bridge is a separate
  grant under the 1 ETH operator cap.
- **Visibility** on Arbitrum is proven from the launcher grid's `safePhase`
  plus the pad's armed flag (the floor API has no Arbitrum rows until the
  site cutover). Trade links use `stonkbrokers.io/safe-launch/token/arbweth-…`
  and Arbiscan.
- **Earnings** still push-pay creator fees as Arbitrum WETH on every taxed
  trade. The StonkUp LP-fee collect path is Robinhood-only until that locker
  is verified on Arbitrum; bonded Arbitrum launches skip that read.

## Contracts (verified 2026-09-15)

| Piece | Address |
| --- | --- |
| Lens (all reads) | `0x7376f9dC6432434D611488CB3E852071ed29E276` |
| WETH pad (`arbweth`) | `0x9540AC4173E5A8c7970743bd13aEc5E9e97FcD22` |
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| Explorer | https://arbiscan.io |
| Grid | `https://stonkbrokers.io/api/launcher/tokens?chain=arbitrum` |
| Guide | https://stonkbrokers.io/integration/StonkBrokers-Launchpad.pdf (rev 8) |

The full 21-lane pad table lives in `ARBITRUM_PADS` in
`src/lib/launchpad/contracts.ts`. Only `arbweth` is a deploy lane today;
the rest are reference data for the library, the agents manifest and MCP.

## X blocks laura.stonkbrokers.io (2026-09-16)

`POST /2/tweets` answers 400 "The Tweet contains an invalid URL" for every
URL on `laura.stonkbrokers.io` — `/mcp`, `/lab` and the bare host alike, with
or without a scheme. The same probe accepts `stonkbrokers.io`,
`stonkbrokers.wtf`, `www.stonkbrokers.cash`, `brokertools.info` and
`github.com`, and the subdomain posted fine on 2026-09-14, so the block is
new and specific to it. Posts that must carry a link point at the repo or an
ecosystem domain until the operator gets it unblocked; `X_BLOCKED_HOSTS` in
`src/lib/publish/x-style.ts` refuses such a draft at the gate with that
reason instead of burning a rail attempt.

Never probe X's validator with something that could succeed: a probe that
padded past 280 characters created two live tweets (deleted immediately).
Probe as a reply to tweet id `1`, which cannot be created.

## Bond venue on Arbitrum

Arbitrum pads accept **only** `bondVenue = 1` (Uniswap v3 1% locked pool).
`bondVenue = 0` (StonkUp CL / Slipstream) reverts `BadParam()` — there is no
StonkUp locker on Arbitrum. The executor coerces arbweth specs to venue 1
before `createLaunch` (verified by simulation 2026-09-15 after Postcard's
first attempt failed on venue 0).

## Smart LP on Arbitrum

The Robinhood Smart LP registry / lens (`0xE874…`, `0x754B…`) have no code
on Arbitrum One. Smart LP vault deployments are Robinhood-chain only until
StonkBrokers publishes Arbitrum vault addresses. Do not point Purser or the
grader at the Robinhood registry from an Arbitrum client.
