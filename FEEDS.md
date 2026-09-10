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

## Env

- `ROBINHOOD_RPC_URL` (optional) overrides the public Robinhood Chain RPC
  used by the nft-buys scan. Keyed RPC URLs belong in server env only  - 
  never in `NEXT_PUBLIC_*`.
