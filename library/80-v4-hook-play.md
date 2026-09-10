# The Mission Tollbooth — Uniswap v4 hook play (design, verified infra)

Operator directive (2026-09-10): let mint keep a share of launched tokens and use
them creatively via Uniswap v4 hooks (tax tokens, fee-funded buybacks). This doc
records what the chain actually supports, the one mechanism designed for it, and
what is executable today versus what waits on tooling.

## Verified reality on Robinhood Chain (4663), 2026-09-10

- **Uniswap v4 IS live on this chain.** PoolManager singleton:
  `0x8366a39CC670B4001A1121B8F6A443A643e40951` (24,009 bytes of code; `extsload`
  answers; Ownable owner `0x2BAD8182C09F50c8318d769245beA52C32Be46CD`). The
  canonical vanity address (`0x…04444c…`) has NO code here — this chain used a
  plain deploy, so never assume the mainnet address.
  Evidence: tx `0xe53a3c4db3c6b996d1c0fcdcb050f6c3951656f5369b1883e56f514d6f3e4eb8`
  emits v4 `Swap` events from that address, one for poolId
  `0xd33c8fd38b06e989cdbd4dffdefab71c4bdd415b24964c8d69e38ff35b068f92` — the
  deepest STONKBROKER venue (native-ETH v4 pool, ~$3.1M; pool state slot read
  back via `extsload`, sqrtPriceX96 nonzero → initialized and trading).
- **Universal Router** at the canonical `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af`
  and **Permit2** at the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
  DexScreener lists ~14 live v4 pools on the chain (dexId `uniswap`, label `v4`).
- **The launchpad has NO native creator allocation.** `createLaunch`'s tuple is
  `(token, name, symbol, supply, vanitySalt, startMcapUsd8, gradMcapUsd8,
  startTaxBps, taxDecayPerMinuteBps, sellsEnabled, bufferSecs, unsoldMode,
  eoaOnly, openEnded, postTaxBps, bondVenue, maxBuyPpm)` — no dev-tokens field;
  `arm(id, supplyWei)` loads the full registered supply. LAURA's honest creator
  economics are the **16.5% trade-tax push** (see 30-integrations.md), paid in
  the lane's quote token. Faking "retention" by market-buying her own token is
  wash trading and stays forbidden (charter rule 3, missionTokenGuard in code).

## The mechanism (one, capped, mission-aligned)

**Mission Tollbooth**: when a LAURA launch graduates (or a future pad version
adds creator allocation), pair a small retained/earned position in a v4 pool
whose hook charges a **dynamic fee** (PoolKey.fee = the dynamic-fee sentinel
`0x800000`) — a persistent, visible "toll" the token's broadcast names honestly.
The hook's `afterSwap` skims the toll and accrues it in the hook; a keeper tick
(scheduler, simulation-first) periodically converts accrued fees and routes them
through the EXISTING missionTokenGuard-approved path to buy **$STONKBROKER only**
— every toll trade becomes mission-token demand. Optional flourish: the toll
decays with pool age, echoing the pad's own startTax decay, so the token's story
("the toll funds the mission, and it fades as the pool matures") is enforced by
code and stated in the launch message.

Caps (inviolable, same as everything else): pool seeding ≤ 0.02 ETH-equivalent
total, treasury floor 0.35 ETH untouched, all sends simulated first, fees buy
$STONKBROKER only — never LAURA's own tokens, never her launches.

## Executable today vs waiting on tooling

- **Today**: the pad's own tax mechanics ARE the tax-token instrument — mint has
  explicit creative range over startTaxBps/decay and a persistent postTaxBps of
  100–500 (the pad REVERTS below 100 — verified by simulation on both the weth
  and stonk pads) with the purpose stated in the token's message. Use it.
- **Waiting**: deploying a v4 hook needs a compiled hook contract (v4-core deps)
  at a CREATE2-mined address whose low 14 bits encode its permissions — this
  repo has no Solidity toolchain or audited hook artifact. Do NOT improvise one
  through the builder executor. When hook tooling lands, the addresses above are
  verified and this design is ready to wire.
