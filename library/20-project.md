# StonkBrokers — project knowledge

## PRIORITY CATALYSTS — operator-set top priorities (2026-09-10)

Two standing goals the operator flagged as top priorities. Alongside the daily grade
levers, every agent should ask: "does this cycle's work advance a catalyst?"

1. **Robinhood leadership engagement (MAJOR CATALYST).** Earn a mention, like, or
   follow from **Vlad Tenev** (Robinhood CEO/co-founder, X: @vladtenev) or **Johann
   Kerbrat** (GM/SVP of Robinhood Crypto, X: @JohannKerbrat) for the operator's two
   X accounts — the **Clutch account** and the **Simple Farmer account** (exact
   handles not yet recorded; confirm with the operator — see `10-operator.md`).
   StonkBrokers is a live Robinhood Chain ecosystem project, so attention from
   Robinhood leadership is legitimacy and reach in one move. The route is content
   those two would credibly engage with — Robinhood Chain ecosystem wins backed by
   real numbers — never tag-begging. Playbook: `skills/thread-craft.md` (content),
   `skills/outreach.md` (ecosystem-surface angle).
2. **Centralized exchange listings for $STONKBROKER (KEY TO GROWTH).** Get listed on
   as many CEXs as possible: majors (Binance, Coinbase, Kraken, Bybit, OKX) are the
   destination; mid-tier CEXs that list small-cap tokens (MEXC, Gate, BitMart, LBank,
   CoinEx) are the realistic first steps. This directly levers the weakest grade
   component — price — via accessibility and liquidity. The route: BD builds and
   maintains listing dossiers and applications for the operator to file. Playbook:
   `skills/outreach.md`.

Reality check so the framing stays actionable: the swarm cannot DM executives, post
to X, or sign listing agreements. It CAN study what the targets engage with, draft
the content and the dossiers, watch for engagement/listing signals, and track
progress — the operator clicks send.

## Core facts

- Token: `$STONKBROKER` at `0xe934e36a439c94017b64a3fece66af12099abf50` on
  **Robinhood Chain (id 4663)**. RPC `https://rpc.mainnet.chain.robinhood.com`,
  explorer `https://robinhoodchain.blockscout.com`. Site `https://www.stonkbrokers.cash`.
- 4444 StonkBroker NFTs, each an ERC-6551 wallet. Activation is paid in $STONKBROKER
  (50% of every activation fee burns); selling/transferring clears activation.

## Product surfaces (each one a story LAURA can tell)

- **Anvil NFT AMM**: swap 666,666 $STONKBROKER + an ETH fee for the next broker in the
  vault (or snipe a number for more). 70% of the ETH fee → Stock Booster pot, 30% → protocol.
- **Clock In v2**: when the fee pot fills, anyone can Clock In; the round's ETH swaps
  into the configured stock token (TSLA, NVDA, AMZN…) and airdrops to activated brokers
  by tier. Fee flow → stock drops is the signature mechanic.
- **Stonk Launcher**: two products under one roof —
  - factory curve tokens (StonkLaunchpadFactory `0x80a7…7281`), listed at
    `/api/launcher/tokens`;
  - **Smart Launch V2 / Safe Launch** pads where LAURA deploys (WETH lane
    `0xFCd6…EC9f`, STONK lane `0x8f67…6cD4`), listed at `/api/safe-launch/floor`.
  Curve fees feed the Buyback Bar → VRNG "Opening Bell" buybacks.
- Also: Broker Box, the vDEX, lockers. Stock-token features unavailable in the US;
  distributions are smart-contract mechanics, not dividends or equity.

## How LAURA is graded

- Daily rubric: **price / protocol revenue / protocol volume / execution**, weighted,
  stamped once per UTC day. Sources: DexScreener (liquidity-weighted price across all
  pairs — several are thin, quote carefully), DefiLlama (protocol dimensions), direct
  RPC reads (Clock In pot, vault brokers, supply).
- Trajectory so far: D 57.5 → C 61.4 → **C 62.7** (2026-09-10). Revenue and volume are
  the persistent laggards; work that levers them (launcher activity, Clock In
  narratives, BD outreach) moves the grade most.

## LAURA's on-chain identity

- Operations wallet `0x6786A106F01987349f653664081b14481e573E21` (chain 4663): deploys
  launches and signs logo/profile attestations. This address IS LAURA's public
  signature — everything it creates is attributable to her.
- First words on-chain (2026-09-10): **LAURA Is Online ($LAURA)**, Safe Launch
  #18000276, token `0x04921d4c9Fc16fe86B995a54696104A128C51387`; followed by
  **Opening Bell ($BELL09)**, #18000277, token `0x3c6fFfF2E1C0A26CbD63918cC5EACFDD7E445343`.
