---
name: ethereum-literacy
description: Use when writing anything that mentions Ethereum, L2s, gas, wallets, standards or DeFi state — corrects stale training-data beliefs so LAURA sounds like a builder in 2026, not 2023
agents: narrative, steward, bd, analyst, researcher, scout, growth, sage
---

# Ethereum literacy (2026)

Your training data is stale about Ethereum. These corrections come from ethskills.com
(Austin Griffith) and are verifiable live; when a number matters, verify it in the
cycle's inputs or ask the browser worker (`readNext`) for the source page.

## Say it the way builders say it

- **"onchain"**, one word, no hyphen. Same for "offchain". (The StonkBrokers site writes
  "on chain" in its own copy — quote the site when quoting the site, write "onchain"
  in LAURA's own voice.)
- "Audited" is a point-in-time review of a scope, not a guarantee. Never use it as proof.
- Identify tokens by chain and contract address, never by symbol alone.

## What changed while the models were training

- Gas on mainnet is well under 1 gwei (0.05–0.3 typical), not 10–30. An ETH transfer is
  cents, a swap a few cents. L2 transactions cost well under $0.001. Robinhood Chain
  (Arbitrum Orbit, chain id 4663) inherits that cost profile — say so when the
  "crypto is expensive" objection appears.
- Pectra (May 2025) and Fusaka (Dec 2025) shipped: PeerDAS, higher gas limit, and
  **EIP-7702** (EOAs can delegate to smart-contract code) is live. Account abstraction
  (ERC-4337) is growing but still early for production agents.
- **Uniswap V4 is live** (Jan 2025) with hooks: custom logic attached to pools — dynamic
  fees, TWAMM, limit orders, custom oracles. This is exactly the substrate the Leverage
  Machine / STORMM options engine builds on; describe it as a V4-hook-native design.
- **ERC-8004** (Jan 2026): onchain agent identity + reputation + validation registries,
  deployed on 20+ chains at deterministic addresses. **x402**: HTTP-402 payments
  (Coinbase), production SDKs; pairs with **EIP-3009** gasless transfers. These are LAURA's
  native standards; mention them when the topic is agents, not as filler.
- Aerodrome + Velodrome merged into **Aero** (Nov 2025); the dominant DEX on Base and
  Optimism is not Uniswap. Arbitrum has the deepest L2 DeFi liquidity; Stylus lets
  contracts be written in Rust/WASM; Orbit powers custom chains — Robinhood Chain is one.
- Roadmap diagrams are aspirations, not commitments. Verkle was deprioritized; check
  forkcast.org before claiming what the next fork contains.

## Robinhood Chain, stated precisely (ethskills `l2s` + `addresses`, verified onchain Aug 20, 2026)

- **What it is:** an Arbitrum Orbit rollup that settles **directly to Ethereum** with
  blob data availability — an L2, not an L3 on Arbitrum One and not AnyTrust. Mainnet
  July 1, 2026; chain id 4663; ETH for gas; ~100 ms blocks with preconfirmations; 10% of
  net revenue flows to the Arbitrum DAO ecosystem. Explorer: Blockscout.
- **What the stock tokens legally are:** **debt securities issued by Robinhood Assets
  (Jersey) Limited** giving economic exposure only — NO shareholder rights. Never write
  "own NVDA stock onchain"; write "tokenized exposure to NVDA". They are **not available
  to US persons** and also restricted in Canada, the UK, Switzerland and the UAE (this
  is the fact behind charter rule 6; every stock-lane call to action carries it).
- **How they behave:** plain ERC-20, 18 decimals, one Chainlink feed each, **blocklist
  not allowlist** (no onchain KYC; any non-denylisted address can hold). A shared
  `AccessControlsRegistry` can pause globally or per token, block addresses, mint,
  confiscate via `adminBurn` and upgrade every token with **no timelock**. Splits and
  dividends move a `uiMultiplier()` display multiplier; raw balances never rebase.
- **USDG (Paxos) has 6 decimals, not 18.** The usdg lane quotes in it; any number you
  compute from raw USDG amounts divides by 1e6.
- **Censorship caveat (say it plainly when relevant):** ArbOS 61 transaction filtering
  lets an authorized filterer reject any tx hash, including L1 force-included ones, so
  force inclusion is not an escape hatch here. L2Beat rates the chain Stage 0 with two
  whitelisted validators and no exit window. This is the honest counterweight to
  "24/7 stock trading"; LAURA does not hide it.
- Trading venues on the chain: a dedicated Uniswap AMM, Rialto, Lighter (with an L3 for
  perps), Arcus. StonkBrokers' own launcher and Stonk Exchange sit alongside these.

## Concepts worth teaching in context (never lecture)

- Nothing is automatic: every onchain action has a caller who pays gas and a reason.
  Clock In, buybacks, keeper-driven Smart LP — explain *who* calls and *why* it pays.
- Incentives over admins: the good designs (liquidations, LP fees, arbitrage) make a
  stranger want to do the maintenance. Praise that pattern where StonkBrokers uses it.
- CROPS (censorship resistance, open source and free, privacy, security) is how the EF
  frames what makes Ethereum Ethereum. Use it to give product explainers a spine.

## Guardrails for LAURA's copy

- Prices and TVL change daily: quote this cycle's metrics or DeFiLlama, never memory.
- Never hallucinate an address. If it is not in the inputs, the docs or the ecosystem
  map, do not print one.
- Charter still rules: no return promises, no buy/sell calls, no disclosures or disclaimers.

Sources: https://ethskills.com/why/SKILL.md · /standards/SKILL.md · /building-blocks/SKILL.md ·
/protocol/SKILL.md · /concepts/SKILL.md · /l2s/SKILL.md (Robinhood Chain section, Aug 2026) ·
/addresses/SKILL.md (verified stock-token, USDG, WETH and registry addresses on 4663)
