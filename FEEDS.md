# LAURA live data feeds

Five read only GET endpoints under `/api/feeds/*` give the swarm the same
external signals the console renders. They are live on the viewer deployment
(`https://laura.stonkbrokers.io/api/feeds/...`) and on any VM deployment of
this app. No auth, no keys, viewer safe  -  every route proxies public data
with module level caching and a last good fallback, so a poll never returns
an empty payload because an upstream hiccuped.

All responses share `{ ok: boolean, stale: boolean, updatedAt: msEpoch, ... }`.
`stale: true` means the upstream failed and you are reading the last good
snapshot.

## GET /api/feeds/launcher

The Stonklauncher onchain tape  -  the same Robinhood Chain launchpad data the
@StonkLauncher_BuyBot Telegram bot tracks.

- `buys[]`: recent buys with `launchId`, `name`, `symbol`, `phase`, `buyer`,
  `eth` (size), `paidIn` (quote symbol), `mcapUsd`, `block`, `ts` (ms epoch).
- `stats`: pad wide aggregates (`launches`, `graduated`, `bonded`, `buys`,
  `sells`, `uniqueBuyers`, `grossBuyEth`, `taxEth`, `bondedRaiseEth`).
- `ethUsd`, `headBlock`.

Upstream: `stonkbrokers.io/api/safe-launch/{buys,stats,floor}` (floor is used
only to resolve launch ids to names, cached 5 minutes). Buy tape cached 5s.

## GET /api/feeds/nft-buys

StonkBroker NFT secondary sales  -  the OpenSea buybot's signal, read straight
from chain. Scans Seaport 1.6 `OrderFulfilled` logs on Robinhood Chain
(public RPC), filtered to the broker collection
`0x539CdD042c2f3d93EbC5BE7DfFf0c79F3B4fAbF0`.

- `sales[]`: `tx`, `tokenId`, `priceEth`, `buyer`, `seller`, `block`,
  `ts` (ms epoch), newest first, up to 40.
- `headBlock`, `collection`.

Notes: matchOrders emits two OrderFulfilled events per trade  -  the route
dedupes by (tx, tokenId) and prefers the bid leg for pricing. A failed log
scan never advances the cursor; the last good sale list keeps serving.
Cold start scans ~600k blocks (~17h); refresh is incremental, cached 60s.

## GET /api/feeds/polymarket

Top open Polymarket prediction markets by 24h volume (public Gamma API).

- `markets[]`: `question`, `slug`, `url`, `outcomes[] { label, price }`
  (price is 0..1 probability), `volume24hrUsd`, `endDate`. Cached 60s.

## GET /api/feeds/defillama

The protocol's public DeFiLlama listing  -  TVL, fees, revenue and Anvil AMM
DEX volume in one compact payload. Cached 5 minutes module side plus a 120s
CDN s-maxage; a failed upstream serves the last good snapshot.

- `protocolUrl`: `https://defillama.com/protocol/stonkbrokers`.
- `tvl`: `currentUsd` (Robinhood Chain TVL), `stakingUsd` (soft staking),
  `series[] { t, usd }` (daily, unix seconds, last 180 points max).
- `fees`: `total24hUsd`, `total7dUsd`, `total30dUsd`, `cumulativeUsd`,
  `series[]` (daily fees).
- `revenue`: `total24hUsd`, `total7dUsd`, `cumulativeUsd`, `series[]`
  (daily revenue, the protocol keep of fees).
- `dexVolume`: `name` ("Clutch Anvil AMM"), `total24hUsd`, `total7dUsd`,
  `cumulativeUsd`, `series[]` (daily DEX volume).

Upstreams: `api.llama.fi/protocol/stonkbrokers`,
`api.llama.fi/summary/fees/stonkbrokers` (and `?dataType=dailyRevenue`),
`api.llama.fi/summary/dexs/clutch-anvil-amm` (note the `-amm` suffix  -  the
bare `clutch-anvil` slug 400s). All four must succeed or the route falls
back to the last good payload, so the DEX series never silently shrinks.

## GET /api/feeds/espn

Live and upcoming games across NFL, MLB and NBA from ESPN's public
scoreboard API, merged and sorted live first.

- `games[]`: `id`, `league`, `shortName`, `state` (`pre | in | post`),
  `detail` (human status), `start`, `home { abbr, score }`,
  `away { abbr, score }`. One dark league never blanks the others. Cached 60s.

## GET /api/feeds/smartlp

The Smart LP balanced band study  -  the Bands agent's dataset. One
`SmartLpLens.viewAll(registry)` eth_call on Robinhood Chain returns every
registered vault (177 as of writing); the route merges the public keeper
activity ledger (`stonkbrokers.io/api/locker/smartlp-activity`) and an
unkeyed ETH/USD mark (coins.llama.fi) to price WETH quoted vaults. Cached
120s module side; a failed reload serves the last good snapshot.

- `mechanics`: `bandTicks` (1200), `recenterTriggerTicks` (240),
  `recenterCooldownHours` (6), `perfFeeBps`, `withdrawFeeBps`.
- `fleet`: `vaults`, `bbVaults`, `tvlUsd` (USDG direct + WETH x ETH mark),
  `compounds`, `collects`, `recenters` (lifetime, fleet wide), `activityAt`.
- `bb[]`: top 12 balanced band vaults by TVL  -  `vault`, `base`, `quote`,
  `feePct`, `tvlUsd`, `bandPct` (where spot sits in the band, 0..100),
  `halfWidthPct`, `edgeTicks` (distance to the nearest band edge),
  `nearEdge` (true inside the 240 tick recenter trigger), `compounds`,
  `recenters`, `lastActivityTs`, `lastRecenterAt`, `paused`.
- `ethUsd`: the mark used for WETH quoted TVL, or null.

Notes: contract addresses  -  registry
`0xE8749183Fbf6A657EB58B3a4D3E4B9Cc09560146`, lens
`0x754Bf8479630bbC22aA7b5E9742156ce89dD3D4d`. The lens call is the only RPC
read, so the route stays one call per refresh regardless of fleet size.

## GET /api/feeds/nft-trends

NFT collection trends on both chains  -  the Curator agent's dataset.
Robinhood Chain reads ride the Blockscout proxy
(`bs-proxy-production.up.railway.app`  -  the direct explorer 403s
datacenter traffic); the Ethereum lane reads `eth.blockscout.com` unkeyed.
Cached 5 minutes; all sources empty at once throws so the last good
snapshot keeps serving.

- `robinhood.broker`: StonkBrokers collection counters  -  `holders`,
  `transfers`, `supply`.
- `robinhood.collections[]`: top real ERC-721 collections by holders
  (Uniswap/Slipstream position NFTs and fee beneficiary tokens are
  filtered out)  -  `address`, `name`, `symbol`, `holders`, `supply`.
- `ethereum.collections[]`: a pinned blue chip set (BAYC, Pudgy Penguins,
  Azuki, Milady, Doodles, Moonbirds) with the same shape. A lane that
  fails to resolve returns empty rather than fake numbers.

## GET /api/feeds/tokens

The token tape  -  the Ticker agent's dataset. DexScreener marks for
$STONKBROKER plus the largest bonded Stonklauncher tokens (tracked set from
the public floor snapshot at `stonkbrokers.io/api/safe-launch/floor`).
Cached 120s.

- `rows[]`: `address`, `symbol`, `name`, `priceUsd`, `change24hPct`,
  `volume24hUsd`, `liquidityUsd`, `quoteSymbol`, `pinned` (true for
  $STONKBROKER). Pinned first, then by 24h volume.
- `tracked`: how many tokens were queried before vetting.

Notes: DexScreener headline liquidity is spoofable, so a pair only counts
when its QUOTE side is canonical WETH / USDG / STONK (native quoted pairs
are labeled "ETH" on the zero address) and the quote side depth
(`liquidity.quote x priceUsd / priceNative`) is at least $100. Tokens whose
top pair fails vetting are dropped, never shown with untrusted numbers.

## Env

- `ROBINHOOD_RPC_URL` (optional) overrides the public Robinhood Chain RPC
  used by the nft-buys scan and the smartlp lens read. Keyed RPC URLs belong in server env only  - 
  never in `NEXT_PUBLIC_*`.
