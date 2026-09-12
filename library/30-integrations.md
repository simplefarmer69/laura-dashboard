# Integrations — verified wire formats

Every format here was verified live during the build. Do not guess variants; these work.

## Smart Launch V2 deploys (chain 4663)

- Deploying is **THREE calls, not one**: (1) `createLaunch(tuple)` payable — registers
  the launch and mints supply **to the creator wallet**; (2) ERC-20 `approve(pad,
  supplyWei)` on the new token; (3) `arm(id, supplyWei)` on the pad — loads the supply
  and **starts the sale clock**. A launch that is created but not armed sits on the
  floor as "waiting" with `startTime 0` forever and never goes live. Check
  `getLaunch(id).armed` before arming (idempotent).
- WETH lane `0xFCd6…EC9f` — use `LAUNCHPAD.pads.weth` in code, never retype addresses.
  Fee from `launchFeeWei()` (currently 0 — a full create+approve+arm costs gas only,
  well under 0.001 ETH). Live `bounds()`: start mcap $1k–$1M, graduation $50k–$10M
  (≥2x start), buffer ≥600s, max start tax 9900 bps.
- **Our WETH pad IS the Stonklauncher UI's active ETH lane** (verified 2026-09-10 from
  the live client bundle after the "not visible" scare). The site keys it `weth2`; the
  /launcher lane menu defaults to it (`XJ.find(e => e.key === "weth2")`) and organic
  launches land on it. Other pads that look tempting but are NOT the UI write path:
  the bundle's legacy native pad `0xEcA5…71f9` (creation disabled — `launchFeeWei`
  returns the 1e24-wei sentinel) and the newer `weth22` pad `0x5BCE…a3B3` (present in
  config but hidden by the lane menu filter). Floor ids are `laneIdOffset + launchId`
  (weth2 offset 18,000,000 → launch #276 = floor id 18000276).
- Always simulate before send; parse the `LaunchCreated` event for launch id + token.
- Vanity salt zero, `unsoldMode` 0, `openEnded` true, `bondVenue` 0 are the proven params.
- **postTaxBps floor is enforced ON-CHAIN**: `MIN_POST_TAX_BPS()` = 100 and
  `MAX_POST_TAX_BPS()` = 500 on every pad; `createLaunch` with postTaxBps 0
  REVERTS (verified 2026-09-10 by simulation on both the weth and stonk pads —
  0 reverts with `0x89f17dee`, 100 and 450 simulate clean). Spec validation in
  code now enforces 100–500.
- **STONK lane verified live** (2026-09-10, same reads as the weth pad): pad
  `0x8f6782c5Aa37804d08a9b7bf3984Ff3245Fd6cD4` (site key `stonk2`, floor id
  offset 11,000,000), quote `0xe934…BF50` ($STONKBROKER), `launchFeeWei` 0,
  identical bounds and 16.5/16.5/50 fee split. `createLaunch` simulates clean
  from the swarm wallet. Creator fees on this lane arrive as **$STONKBROKER**
  — mission-token income — and every curve trade prints mission-token volume.
- **All five STOCK lanes verified live** (2026-09-10, read + simulated from the
  swarm wallet): gme `0x4B9D…8cFD` (35 launches), nvda `0xEe96…F9fb` (8),
  aapl `0xB045…a864` (9), spcx `0x0c3b…c947` (15), uso `0xDb3C…053B` (3).
  Every stock pad reports `launchFeeWei` 0 and bounds IDENTICAL to the weth pad
  (start $1k–$1M, grad $50k–$10M, max start tax 9900, buffer ≥600s, postTax
  100–500), and `createLaunch` with the proven default params **simulates clean
  on all five**. The quote asset is the tokenized stock, so creator fees accrue
  in GME/NVDA/AAPL/SPCX/USO. The only gate is the WEEKEND window (Chainlink
  us_equities_24/5 feeds publish nothing Friday close → Monday 00:00 UTC; code
  blocks stock deploys Friday 20:00 UTC → Monday 00:15 UTC in `lanes.ts`) — on
  a weekday a stock-lane deploy is as routine as a weth one.
- **No creator supply allocation exists on the pad**: the `createLaunch` tuple
  has no dev-tokens field and `arm` loads the full registered supply. Creator
  economics = the 16.5% trade-tax push, nothing else; "retention" via buying
  her own token is wash trading and stays forbidden.

## Smart Launch V2 creator economics (verified 2026-09-10 from verified pad source)

How LAURA EARNS from her launches — confirmed against the Blockscout-verified
`StonkSafeLaunchpadV2` source (`_splitTax` / `_pushCreatorQuote` / `flushCreatorQuote`)
and reconciled to the wei on-chain:

- **Every curve trade (buy AND sell) pays the launch tax; the pad splits it**:
  `creatorFeeBps` **1650 (16.5%) to the CREATOR**, `protocolFeeBps` 1650 to the
  protocol treasury, `lpFeeBps` 5000 escrowed for the locked bond pool, remainder
  (~17%) to the referral/Clock In punch machinery. Snapshotted per launch at create
  (`creatorFeeBpsSnap` on `getLaunch(id)`).
- **Creator fees are PUSH-PAID instantly** inside each trade: the pad calls
  `quote.transfer(creator, tax × creatorFeeBpsSnap / 10000)`. On the WETH lane the
  income lands in the wallet **as WETH** (unwrap to spend as ETH); on the STONK lane
  as $STONKBROKER. Verified: two 10%-taxed buys on launches #276/#277 delivered
  exactly 0.000066922052191435 WETH to LAURA's wallet (16.5% of the 0.000405588 tax).
- **Claim path (fallback only)**: if the push transfer fails, the amount accrues in
  `creatorQuoteOwed(id)` (event `CreatorQuoteAccrued`) and anyone can call
  `flushCreatorQuote(id)` — nonpayable, permissionless, always pays the creator
  (event `CreatorQuoteFlushed`, reverts `NothingOwed()` when zero). For a plain EOA
  creator the push never fails, so this ledger normally stays 0 (it is 0 for all 277
  WETH-lane and 79 STONK-lane launches today).
- **Graduation PRINCIPAL is not creator income, but the LP fee stream IS**
  (verified 2026-09-10 against the Blockscout-verified `SafeLaunchBondLibV2` and
  `StonkUpLockerCL` sources): at `graduate` → `bond` the raise (`realQuote`) plus
  the escrowed LP-fee reserve mint into a permanently locked CL/Uniswap-v3 pool,
  BUT `_lockPosition` mints the lock NFT, which carries the fee-claim right, and
  transfers it to the CREATOR (`lockNft.transferFrom(pad, creator, lockTokenId)`,
  FeeMode `CollectTwentyPercent`). The creator then calls
  `StonkUpLockerCL.collectFees(lockId, 0, 0)` (locker `0xc1AfA59e2aBC1C868C51a1F799a7578EaCfEa076`,
  shared by the weth and stonk pads; v3-venue locker `0xFc96CF67eCC55bE4AdABc3AecBe6Ad6349f11223`)
  to collect the pool's accrued swap fees: 80% to the creator, 20% protocol cut.
  Lock ids are readable from `pad.poolsOf(id)`. While a lock is gauge-staked its
  swap fees go to the pool's voters (`collectFees` reverts `PositionStaked`);
  `pendingEmissions`/`claimEmissions` cover the staked $UP path. Exception: a
  zero-raise bond returns the unsold supply to the creator. Degen (`icoBoost`)
  launches stream the LP share to the ICO Kickstarter per trade instead of escrowing.
- Earnings tracking in code: `src/lib/launchpad/earnings.ts` — sums `taxPaid` from
  `SafeBuy`/`SafeSell` logs × `creatorFeeBpsSnap`, reads `creatorQuoteOwed`, detects
  bonded-launch LP fees by simulating `collectFees` read-only, and snapshots wallet
  ETH/WETH/STONK into `state.treasury` every ~10 min from the scheduler tick.
  Autonomous claiming (ledger flush + LP collect) runs by default
  (`settings.autoClaimEarnings`, default true) above a configurable dust threshold:
  `EARNINGS_POLICY.claimMinEthEquiv`, default 0.0005 ETH-equivalent, env override
  `FEE_CLAIM_MIN_ETH`; non-WETH lanes convert through `SafeLaunchLensV2`
  `quoteUsdView`/`ethUsdView`. LP collections emit the `fees.claimed` event.
- Implication: **creator income scales with trade volume × tax bps, and does not
  end at graduation**. Tax decays per minute from `startTaxBps` to `postTaxBps`,
  so early volume under high tax is where the curve earns; after bonding the
  locked pool keeps paying the creator 80% of swap fees for as long as it trades.
- Live reads 2026-09-10 (launches #276 LAURA / #277 BELL09 / #278 SPEAKS, weth pad):
  `creatorFeeBps` 1650 / `protocolFeeBps` 1650 / `lpFeeBps` 5000 on BOTH the weth
  and stonk pads; `creatorQuoteOwed` = 0 wei on all three (push-pay never failed;
  pad-wide `totalOwed` is 0); none graduated/bonded yet, so `poolsOf` is empty and
  no LP fee stream exists yet — lifetime curve income so far is the pushed
  0.000100 WETH sitting in the wallet.

## Treasury buys — $STONKBROKER swap venue (verified 2026-09-10)

How LAURA BUYS the mission token with treasury ETH (`src/lib/launchpad/treasury.ts`):

- **Venue: Uniswap v3 on Robinhood Chain via SwapRouter02
  `0xCaf681a66D020601342297493863E78C959E5cb2`.** Verified three ways: (1) its
  `factory()` returns `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` — the exact factory
  that deployed the deepest v3 STONKBROKER/WETH pool
  (`0x9cd74d5980A4BF60408B9bA2B0F6a3d368EBf594`, ~$881k liquidity, fee tier 10000);
  (2) its `WETH9()` returns the chain's canonical WETH `0x0Bd7…AD73` (same token the
  launchpad's WETH lane quotes in); (3) 79 of the last 418 organic swaps on that pool
  routed through it. `factoryV2()` answering marks it as SwapRouter02 (params struct
  WITHOUT deadline).
- Two live v3 fee tiers carry STONKBROKER/WETH liquidity: 10000 (1%, deepest) and
  3000 (0.3%, `0xA9d49CAa5E906558dacDC66d563Ac78f0c26d4ef`). The buy path quotes BOTH
  via `simulateContract` and takes the better output — at our sizes (≤0.005 ETH) the
  0.3% tier usually wins on fee.
- The single deepest STONKBROKER venue overall is a **Uniswap v4 native-ETH pool**
  (~$2.8M, pool id `0xd33c…8f92`). Not used: v4 needs Universal Router command
  encoding, and at treasury buy sizes the v3 slippage difference is noise. Revisit
  only if buy sizes ever grow 100x (they must not — caps).
- **Uniswap v4 singleton located and verified on 4663 (2026-09-10)**: PoolManager
  `0x8366a39CC670B4001A1121B8F6A443A643e40951` — NOT the canonical vanity address
  (which has no code here). Universal Router and Permit2 sit at their canonical
  addresses. Full evidence and the hook design that uses them:
  `library/80-v4-hook-play.md`.
- Send pattern: `exactInputSingle` with `tokenIn = WETH9`, `msg.value = amountIn` —
  the router wraps native ETH itself; no WETH approve/wrap step needed. Recipient is
  the treasury wallet; received amount measured as the wallet's STONK balance delta.
- **TREASURY_CAPS (hard, code-level — `src/lib/launchpad/treasury-caps.ts`)**:
  max **0.005 ETH per buy** · max **0.01 ETH per rolling 24h** · min **6h between
  buys** · never below a **0.35 ETH treasury floor** · **3% slippage guard** ·
  0.0005 ETH dust minimum. `settings.autoTreasuryOps` (default ON) arms the
  scheduler tick; the caps apply to every path including manual calls.
- **Charter guard in code**: the buy path refuses any token that is not the verified
  $STONKBROKER address AND refuses anything LAURA launched herself — own-token buys
  are wash trading (charter rule 3) and are blocked before simulation.

## Stonk Exchange (vDEX, "powered by up.") — Smart LP contracts (verified 2026-09-10)

The protocol's own DEX is a **Velodrome/Slipstream-style concentrated-liquidity
deployment** with gauge staking and $UP emissions. Addresses reverse-engineered from
the stonkbrokers.cash `/exchange` client bundle, then verified on-chain:

- **CL factory** `0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3` — matches `factory()` of
  the live up. pools DexScreener lists (dexId "up").
- **NonfungiblePositionManager** `0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf` —
  `factory()` returns the CL factory, `WETH9()` the canonical WETH. Mint params are
  Slipstream-shaped: `{token0, token1, tickSpacing, tickLower, tickUpper,
  amount0/1Desired, amount0/1Min, recipient, deadline, sqrtPriceX96}` (NO fee field;
  `sqrtPriceX96: 0` when the pool exists). Native ETH goes in as
  `multicall([mint, refundETH])` with `msg.value` — the manager wraps and refunds.
- **Voter** `0x7F749fDD351C1Ceed82d76d7699CB631Eb8332a7` — `gauges(pool)` resolves the
  staking gauge. **Gauge flow**: `positionManager.approve(gauge, tokenId)` →
  `gauge.deposit(tokenId)`; claim `gauge.getReward(tokenId)`; exit
  `gauge.withdraw(tokenId)` — **no lockup anywhere on this path**.
- **STONKBROKER/WETH CL pool** `0xB11ba9a4d345434c25d625C076f23Ad14abC6B3c` (token0
  WETH, token1 STONK, tickSpacing 200, fee 1%). Its gauge
  `0x534577F108201CDD0f121ED5f7Ff97B8994bbD07` had a LIVE rewardRate (~0.094 $UP/s)
  paying **$UP** `0x57C0E45cB534413D1C20A4240955d6bB250BB4F1` on 2026-09-10.
- Other bundle constants (recorded, unused): swapRouter `0xC062…9415`, quoter
  `0x0398…5B49`, votingEscrow `0x5d32…B7B6` (veUP LOCKUP — never use for treasury),
  minter, rewardsDistributor, compounderVault, emissionDepositRouter.
- Velodrome-CL nuance: a **staked** position earns gauge emissions ($UP) instead of
  swap fees (fees route to the voter machinery); an unstaked position earns the pool's
  swap fees directly.
- Code: `src/lib/launchpad/smart-lp.ts` — full-range mint (never out of range, no tick
  management), auto-stake, value refresh, and the verified exit path
  (`exitLpPosition`: unstake → decreaseLiquidity → collect). Caps live in
  `treasury-caps.ts`: **max 0.02 ETH-equivalent total in LP/staking**, 1% amount
  tolerance, 0.001 ETH minimum side, and the same 0.35 ETH treasury floor.

## Launcher branding API (stonkbrokers.cash)

- **Upload logo**: `POST /api/launcher/token-image` with raw image bytes
  (`Content-Type: image/webp`) → `{ok, imageHash}` (content-addressed keccak; readback
  at `/api/launcher/token-image/<hash>`). Retry up to 3x with 1.2s·n backoff; don't
  retry 4xx except 429. Logos: 256px WebP, **48KB cap**.
- **Attach logo** (creator wallet only): sign exactly
  `["StonkBrokers Safe Launch logo", "chain: <id>", "token: <addr lowercase>",
  "image: <hash lowercase>", "signed at: <ISO>"].join("\n")`
  → `POST /api/safe-launch/token-logo` `{token, imageHash, signedAt, signature}`.
- **Attach profile links** (creator wallet only): same pattern, header line
  `"StonkBrokers Safe Launch profile"`, fields `x / website / telegram`
  → `POST /api/safe-launch/token-profile`. Website must be full https://; telegram
  `https://t.me/…` or `@handle`.

## Public reads

- Factory-curve grid: `GET /api/launcher/tokens?sort=new`. For Safe Launch tokens it
  also carries the UI route (`safeHref`, e.g. `/safe-launch/token/weth2-laura-276`)
  and the attached `imageHash`.
- **`GET /api/safe-launch/floor` is THE surface the /launcher (Stonklauncher) UI
  renders from** — the client bundle fetches it and filters client-side. A launch is
  user-visible only when its floor row reports phase `live` (or `bonded`/
  `graduated`); a created-but-unarmed launch sits as `waiting` among 100+ others and
  is effectively invisible. `verifyLaunchVisible()` in `service.ts` checks exactly
  this; the executor runs it after every arm.
  `GET /api/launcher/token/<addr>` returns "unknown token" for
  Safe Launch deploys — that is normal, not an error.
- Batch logo map: `GET /api/safe-launch/token-logo?tokens=<a>,<b>`.
- Also available: `/api/safe-launch/stats`, `/leaderboard`, `/mcap-series`, `/buys`.

## BrokerTools (brokertools.info, verified 2026-09-10)

BrokerTools is an independent explorer and data terminal for Robinhood Chain
(their words: "high context explorer and data terminal"). It indexes Stonklauncher
tokens, StonkBrokers NFTs, transactions and addresses. Public, keyless, read only.
Two JSON endpoints are wired into the swarm:

- `GET https://brokertools.info/api/firehose` returns the ~120 most recent
  chain wide DEX trades (token, symbol, side, usd, priceUsd, venue). The intel
  digest condenses this into a tape line every cycle: trade count, window span,
  buy vs sell USD flow, most traded symbols, and $STONKBROKER's own trades with
  net flow. Read it as "what is the chain trading right now".
- `GET https://brokertools.info/api/launches?offset=0` returns the Stonklauncher
  index (total launches tracked plus rows sorted by mcap with buyers and phase).
  The digest carries the total and the top launches by mcap. Use it to sanity
  check launch concepts against what is actually holding a market cap.
- The dashboard proxy is `/api/feeds/brokertools` (2 minute cache, last good
  fallback). Search endpoints (`/api/suggest?q=`) and per token tape
  (`/api/index/<token>/firehose`) exist but are not wired.

Every agent also receives a live TVL line each cycle from the same intel pass:
protocol TVL on Robinhood Chain from DefiLlama (slug `stonkbrokers`, with 24h
and 7d change) plus the Smart LP vault fleet TVL from the lens read. TVL is a
graded lever; Smart LP deposits grow it.

## X (Twitter)

- `POST https://api.x.com/2/tweets` signed OAuth 1.0a HMAC-SHA1 (no SDK; `node:crypto`).
  Threads = reply chains, 280-char sentence-boundary splits, 1.2s between posts.
- App key/secret + bearer are on file; **bearer is read-only** — posting needs the
  operator's access token pair (Read & Write) in env. `runtime.x` on `/api/state`
  reports readiness (`xStatus()`), and env changes only become visible after a
  process restart.
- **We post as @AiAgentkAia** (user id 1864328060327350278). The operator approved
  this account for the swarm, and it is SHARED: the operator's automated NFT sales
  bot tweets sales from the same account on its own schedule. Behave like a good
  roommate. Our posts complement the sales ticker, they never drown it, and we
  NEVER reply to, quote or link the account's own tweets as if they came from
  another party (a sales-bot tweet is us, not a stranger).
- **Charter applies in full on X**: LAURA's own voice with no disclosures or
  disclaimers, no promises of returns, no sockpuppets, no pretending the sales bot
  is independent validation.
- **Shared-account guardrails are enforced in code** (`src/lib/publish/x-guard.ts`),
  not just etiquette: minimum 30 minutes between swarm posts and max 10 per rolling
  24h (operator directive 2026-09-12; replies to people who tag the account are a
  separate rail with no daily cap) (env-tunable via `X_MIN_MINUTES_BETWEEN_POSTS` / `X_MAX_POSTS_PER_DAY`; one
  publish = one post even for threads), a local memory of recent posts
  (`data/x-post-log.json`) that refuses near-duplicates, and a block on any body
  mentioning or linking @AiAgentkAia itself. Guard refusals return 429 from the
  publish route; write X drafts knowing a slow, non-repetitive cadence is the rail.
- **Smoke test before going live**: `POST /api/drafts/<id>/publish?dry=1` runs the
  full pipeline (creds check, guard verdict, exact tweet split) without posting.
  The FIRST real post after keys land must be a single controlled test from the
  persona (announcing the swarm coming online is fine), verified live on the
  timeline before the normal pipeline takes over under the caps.

## LLM

- Provider: Anthropic via Vercel AI SDK. Model: **claude-fable-5-1** (operator-granted;
  key also exposes claude-fable-5, claude-opus-5, claude-sonnet-5 for fallback).
- Structured output: generous zod caps + one-shot schema-repair retry (feed the
  validation error and raw output back). Pin `TODAY (UTC)` into producer prompts.

## Chat connectors (built, awaiting tokens)

- Telegram long-polling (`getUpdates`): DMs always; groups only /commands, @mentions,
  replies-to-bot. Discord via discord.js (needs Message Content intent;
  `serverExternalPackages: ["discord.js"]` in next.config.ts or the build breaks).
