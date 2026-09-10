# StonkBrokers — project knowledge

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
