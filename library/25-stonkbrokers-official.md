# StonkBrokers official docs (harvested 2026-09-10)

The OFFICIAL layer. On-chain wire formats: `library/30-integrations.md`; on conflict, on-chain wins. One app, three domains: stonkbrokers.io (ecosystem), stonkbrokers.wtf (launcher), www.stonkbrokers.cash.

WHAT IT IS: an on chain decentralized incubator and DeFi ecosystem built by SB (BVI) Ltd on Robinhood Chain, created by Clutch Markets.

VOCABULARY: "Stonklauncher" = launcher site; "Smart Launch" = pad protocol; "Stonk Launcher" (two words) = factory launchpad; "Safety Deposit Box" = lockers; "Clock In" = distributions; "Special Projects" = incubated teams; "Opening Bell" = VRNG buybacks; "STORMM" = Leverage Machine engine.

TOKENOMICS: $STONKBROKER, fixed-supply ERC-20 (OZ + Burnable + Permit, 18 dec). No team allocation, no vesting, no taxes, no admin key; supply only burns; totalSupply ~2.390B (2026-09-10). 4,444 broker NFTs (ERC-6551), minted out. Full detail below.

## $STONKBROKER whitepaper (stonkbrokers.io/docs/stonkbroker-token)

- Contract follows OpenZeppelin ERC-20 with ERC20Burnable and EIP-2612 permit. No staking, farming, reward accrual, transfer tax, pause, freeze, blacklist, admin mint, or proxy. Ownerless after deploy.
- Full supply minted once in the constructor. "Fee sinks only": circulating supply decreases through AMM fee flows and voluntary burns (the 50% activation burn is the big one), never through scheduled unlocks.
- Security: "HasLock Certified" audit plus penetration assessment by Admir Zlatic (0xSimpleFarmer), Hashlock SSCAC certified (issued 2026-02-03). Zero findings on the ERC-20 surface. HasLock is StonkBrokers' own certification mark for the review.
- A third-party Howey Test securities opinion is being drafted and will be published on the whitepaper page.
- Source: github.com/Clutch-L4bs/stonkbroker-erc20. Official stance: holding STONKBROKER confers no equity, dividends, or revenue share.

## Launcher, official framing (stonkbrokers.wtf)

- Four launch modes: **Degen** (trading opens first block at a flat 1% fee; half of every fee streams to the ICO Bonus pot), **Degen Hybrid** (decaying snipe tax, then the flat fee), **Fair Launch** (short opening buffer, same starting line), **Guaranteed Bond / anti snipe** (snipe tax up to 99% falling every minute, raise bonds at the bell). LAURA's Safe Launch deploys are the Guaranteed Bond family.
- Launching is free, gas only, "no listing fees and no hidden charges". Simple launch (name, ticker, logo, links) vs Custom launch (start mcap, graduation mark, opening tax, window, bond venue, unsold-supply behavior) vs Bring your own ERC20.
- "Bring your own ERC20" runs on the r2 pad generation (docs also label it "V3 pads (external token)"), live again 2026-08-23 with the abort() C-01 patch. This is the official identity of the pad our integrations doc calls "weth22" `0x5BCE…a3B3`: an external-token surface hidden from the standard lane menu, not a dead pad.
- Quote lanes on V2 pads: WETH, STONK, USDG, GME, NVDA, AAPL, SPCX, USO, YBTC (docs headline says "eight lanes" but lists nine; trust on-chain enumeration). "Uniswap V3" in launch copy means bondVenue 1, an optional graduation venue, not a pad generation. Lanes seal when `launchFeeWei()` reads 1e24.
- Graduation guarantee, official words: the LP position mints into the Safety Deposit Box, "a permanent locker with no unlock and no admin key... anyone can launch, nobody can rug the LP". The lock NFT only collects the fee share.
- ICO Bonus: a sitewide meter charging toward a $1M treasury target, funded by Degen fee flow. Opening Bell buybacks (factory-curve floor): a fee slice charges the public Buyback Bar; DERP VRNG picks both the ring moment and the target token (odds weighted by fee contribution); anyone can Clock In to ring the bell and earn a tip while the whole bar market-buys the drawn token. Marketed as "the highest-RTP meme-coin trading floor crypto has ever seen".
- StonkLauncher Buy Bot on Telegram: live buy alerts, `/track <CA>` in any group.

## NFTs, Anvil AMM, Clock In (official numbers)

- Collection lore: 4,444 unique pixel art stock brokers, mid 2026, one of the first ERC-6551 token-bound-wallet collections. Every TBA was seeded with a random Robinhood stock token at mint (TSLA, AMZN, PLTR, NFLX, AMD and more). Whitelist was earned by burning Pup Cup (Ethereum) or Clutch Puppies (ApeChain) NFTs; burn-to-mint closed 2026-07-16. Secondary: OpenSea plus the Anvil AMM. No Meebits or faction lore exists in any official material.
- Anvil AMM: flat price 666,666 $STONKBROKER + ETH fee per broker (10% swap, 15% snipe). Loans: borrow the full principal against a broker; ETH fee upfront at 15% APR, split 70% StockBooster / 30% protocol.
- Activation tiers (paid in $STONKBROKER, 50% burned): Base 66,666 (100x), T1 166,666 (125x), T2 366,666 (160x), T3 666,666 (200x), T4 1,666,666 (333x). Activation clears on transfer.
- Clock In v2 ("Directed Booster"): each activated broker elects up to 3 payout tokens with custom weights (default ETH). When the ETH bar fills, any wallet cranks the round: one pass swaps the pot into every demanded token and credits brokers pro rata by tier. Overtime is retired, merged into Clock In v2 (royalties feed the same engine).
- Broker Box, "World Wide Stonk Exchange": Certificate Counter (1x bearer deeds of any listed stock, flat $2 fee) and Degen Mode (DERP VRNG multiplier roll, 0.70x to 50x, design RTP 90%, 10% house edge burned into bytecode: 2.5% creator, 2.5% StockBooster, 5% protocol, plus a 5% sell-back spread). Machines are ownerless and fail closed. Stock-token play is unavailable in the United States.

## Exchange, Smart LP, Safety Deposit Box

- The Stonk Exchange is the vDEX "powered by up.", a ve(3,3) engine (Velodrome-style v2 pools, Slipstream CL, gauges, weekly veUP emissions). $UP is the native DEX token; $STONKBROKER is the governance token directing flow. Graduated launcher tokens get gauges so LPs earn $UP instead of the token funding its own liquidity.
- Smart LP is marketed as "decentralized stock token market making" and "volatility farming": 160+ immutable vaults over Uniswap v3 stock-token pools, three strategies (single sided ask ladder, full range, balanced band). 10% performance fee on collected fees only, split between StockBooster and $STONKBROKER buybacks; 0.1% withdraw fee stays in the vault. Broker TBAs can stake directly.
- Safety Deposit Box: five desks (V3 locker, V4 locker, up. CL locker, up. v2 locker, ERC-20 vesting). Fee modes fixed at lock: 0.5% upfront, or 20% of swap fees (offered to Special Partners). Lock styles: hard lock, linear vesting, permanent. Locker protocol fees route to an ownerless Safety Deposit Clock In router, 90% community / 10% protocol. Hashlock-certified audit by 0xSimpleFarmer signed 2026-07-15: 0 critical, 0 open high.

## Special Projects and roadmap

- Official incubator pitch: "reserved for immense talents and new tech" using StonkBrokers as incubator and distribution channel. Every Special Projects token is paired to $STONKBROKER by liquidity, seeded at launch finalize, on top of its main base pairing. Independent teams, own token, own risk, removable for ToS violations, never presented as subsidiaries or endorsements. Roster detail: `library/85-special-projects.md`. Live roster 2026-09-10: DERP (first partner, VRNG entropy mining), TickerYard $YARD, Card Wall $WALL (graduated at $1M through the anti snipe curve, bonded into locked WALL/ETH and WALL/STONKBROKER pools), Chain Mancers $MANCER, Oakmont Vault $STRIKE, up. $UP.
- Roadmap ("Opening Bell Schedule"): Launcher and Exchange live now; **Leverage Machine, September 2026**: permissionless options exchange on stock tokens, STORMM engine on Uniswap V4 hooks. LPs deposit ETH into put liquidity and stock tokens into call liquidity inside a strike range and earn LP fees plus option premiums plus multiplier dividends; positions mint as tradeable ERC-721s; leverage without liquidations; "LPs are the house". Weekly public lessons planned in the community Discord. Also queued: Referral Desk (codes, fee share on launcher links), permissionless Broker Box factory, exchange vote suite.
- Robinhood Chain, official guide: Arbitrum Orbit L2 run by Robinhood, chain 4663, ETH gas, ~100ms blocks, no public mempool (first come first served). Stock tokens are ERC-8056: corporate actions move an on-chain uiMultiplier() (shares per token), balances never rebase; Chainlink feeds quote the full token price. Official registry: api.robinhood.com/rhj/assets.

## Legal and licensing (matters for content and BD)

- Protocol code is BUSL 1.1 (effective 2026-08-25, converts to MIT 2029-08-25; Anvil AMM 2029-08-12). Deploying competing forks (Clock In engine, Smart Launch pad, Broker Box, Anvil fork) violates the license; integrating against the live deployments is explicitly allowed. Public ABIs and verified bytecode are not a production-use grant. Trademarks: StonkBrokers, Clock In, Smart Launch, Stonklauncher, Clutch, Anvil.
- Standing disclaimer for ALL swarm content: distributions are promotional rewards under the StonkBrokers Marketing Program, not dividends or investment income. Stock-token swaps (Clock In, Overtime, Broker Box) are restricted in the United States. Registered operator: SB (BVI) Ltd, Tortola, British Virgin Islands.

## Agent pointers

- narrative: use the official vocabulary above verbatim, and mirror the disclaimer stance (rewards, not dividends; no profit promises). The Opening Bell buyback story and "nobody can rug the LP" guarantee are the strongest official hooks.
- bd: the incubator pitch plus the $STONKBROKER liquidity pairing at launch finalize is the official Special Projects offer; integrators get free rein against live deployments (BUSL blocks forks, not integrations); integration kit at `/integration/` (ABIs, launchpad PDF).
- nftintel: collection provenance (pixel art, TBA seeded stock, Pup Cup / Clutch Puppies burn-to-mint, OpenSea + Anvil venues) is the official lore; there is no Meebits connection.
- any agent: machine-readable context ships at `/llms.txt`, `/llms-full.txt` and `/ecosystem.json` on all three domains; refetch there when official framing is in doubt.
