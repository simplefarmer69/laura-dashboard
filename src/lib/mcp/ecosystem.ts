import { createPublicClient, formatUnits, http, parseUnits } from "viem";
import SafeLaunchLensAbi from "@/lib/launchpad/SafeLaunchLensV2.abi.json";
import {
  ARBITRUM_PADS,
  LAUNCHPAD,
  LAUNCH_CHAINS,
  PAD_LANE_KEYS,
  ROBINHOOD_CHAIN,
  SITE_LANE_KEY,
  laneChain,
  type LaunchChainKey,
  type PadLane,
} from "@/lib/launchpad/contracts";
import { LANE_INFO } from "@/lib/launchpad/lanes";
import { QUOTE_TOKENS } from "@/lib/launchpad/earnings";
import { NIGHTSHADES, NIGHTSHADES_FACTIONS } from "@/lib/launchpad/nightshades";
import { DEFAULT_SETTINGS } from "@/lib/swarm/roster";
import type { Abi } from "viem";

/**
 * The ecosystem layer of LAURA's MCP server: the parts an outside agent needs
 * in order to *act*, not just read a feed. Three groups live here.
 *
 *  1. `ecosystemMap()` — the whole StonkBrokers surface area in one document:
 *     every protocol an agent can integrate with, what it does, where its
 *     addresses and APIs are, and the one thing that most often trips an
 *     integrator on each. Facts come from library/25-stonkbrokers-official.md
 *     (the harvested official docs) and from the verified addresses in
 *     launchpad/contracts.ts — never invented here.
 *  2. `quoteLaunch()` — a real SafeLaunchLensV2 quote for a live curve on
 *     either chain. The single most useful call for an agent that wants to
 *     size a trade, and the one place where reimplementing the tax math goes
 *     wrong, so the lens answers instead.
 *  3. `launchTokenDetail()` — one launcher token resolved across both chains'
 *     grid APIs, with its phase, curve progress and trade page.
 *
 * Everything is read-only and public. No wallet, no signing, no secrets.
 */

const LENS_ABI = SafeLaunchLensAbi as Abi;

function clientFor(chain: LaunchChainKey) {
  const info = LAUNCH_CHAINS[chain];
  return createPublicClient({ chain: info.chain, transport: http() });
}

/* ------------------------------ ecosystem map ----------------------------- */

export interface EcosystemEntry {
  key: string;
  name: string;
  category: "chain" | "token" | "launchpad" | "dex" | "locker" | "nft" | "game" | "index" | "agent";
  what: string;
  /** What an agent can actually do with it today. */
  agentOpportunity: string;
  urls: string[];
  contracts?: Record<string, string>;
  /** The mistake integrators make here. */
  gotcha?: string;
  /** MCP tools on this server that read it. */
  tools: string[];
}

export function ecosystemMap(): { generatedAt: string; summary: string; entries: EcosystemEntry[] } {
  const entries: EcosystemEntry[] = [
    {
      key: "robinhood-chain",
      name: "Robinhood Chain",
      category: "chain",
      what: "Arbitrum Orbit L2 operated by Robinhood. Chain id 4663, ETH gas, roughly 100ms blocks, no public mempool (first come first served). Tokenized stocks are ERC-8056: corporate actions move an on-chain uiMultiplier() (shares per token) and balances never rebase.",
      agentOpportunity: "Cheapest chain in the ecosystem to transact on and the home of every contract below. Point an RPC client at it and you can read or trade everything here.",
      urls: ["https://robinhoodchain.blockscout.com", "https://api.robinhood.com/rhj/assets"],
      contracts: { chainId: String(ROBINHOOD_CHAIN.id), rpc: ROBINHOOD_CHAIN.rpcUrls.default.http[0] },
      gotcha: "No public mempool means no mempool-sniping strategy works here; ordering is first come first served at the sequencer.",
      tools: ["contracts", "chain_compare"],
    },
    {
      key: "arbitrum-one",
      name: "Arbitrum One (second launch chain)",
      category: "chain",
      what: "Robinhood Chain settles to Arbitrum One, and since 2026-09-15 the Stonklauncher runs the same Smart Launch V2 pads there: 21 quote lanes, the same ABI, bonded pools graduating into Uniswap v3 at the 1% fee tier.",
      agentOpportunity: "An agent already on Arbitrum can trade StonkBrokers curves without bridging anywhere. Same lens, same pad ABI, ordinary Arbitrum gas.",
      urls: ["https://arbiscan.io", LAUNCH_CHAINS.arbitrum.gridApi],
      contracts: {
        chainId: String(LAUNCH_CHAINS.arbitrum.chain.id),
        lens: LAUNCH_CHAINS.arbitrum.lens,
        weth: LAUNCH_CHAINS.arbitrum.weth,
        wethPad: LAUNCHPAD.pads.arbweth,
      },
      gotcha: "Arbitrum pads only accept bondVenue 1 (Uniswap v3). There is no StonkUp locker on Arbitrum, so bondVenue 0 reverts BadParam() at createLaunch.",
      tools: ["arbitrum_launcher", "contracts", "quote_launch"],
    },
    {
      key: "stonkbroker",
      name: "$STONKBROKER",
      category: "token",
      what: "Fixed-supply ERC-20 (OpenZeppelin, Burnable, EIP-2612 permit, 18 decimals). No team allocation, no vesting, no transfer tax, no admin key, ownerless after deploy. Supply only ever decreases, through AMM fee flows and voluntary burns.",
      agentOpportunity: "The governance and revenue-focus asset of the ecosystem. Protocol fees across the launcher, exchange and lockers route value toward it, so it is the index trade on ecosystem activity.",
      urls: ["https://stonkbrokers.io/docs/stonkbroker-token", "https://github.com/Clutch-L4bs/stonkbroker-erc20"],
      contracts: { token: DEFAULT_SETTINGS.tokenAddress },
      gotcha: "Holding confers no equity, dividends or revenue share; distributions elsewhere in the ecosystem are promotional rewards, not investment income.",
      tools: ["pairs", "token_tape", "holders"],
    },
    {
      key: "stonk-launcher",
      name: "Stonk Launcher / Smart Launch V2 pads",
      category: "launchpad",
      what: `Bonding-curve launchpad with four launch modes (Degen, Degen Hybrid, Fair Launch, Guaranteed Bond / anti snipe). ${PAD_LANE_KEYS.length} quote lanes across two chains: a token is quoted in WETH, $STONKBROKER, USDG or a tokenized stock, and the curve's tax is push-paid to the creator on every trade. At graduation the LP mints into the Safety Deposit Box permanently.`,
      agentOpportunity: "The highest-frequency surface in the ecosystem. Agents can quote and trade any live curve through the lens, or deploy their own token (launching is free, gas only). Every trade pays protocol revenue.",
      urls: ["https://stonkbrokers.wtf", "https://www.stonkbrokers.cash/launcher", LAUNCHPAD.gridApi, LAUNCHPAD.floorApi],
      contracts: { ...LAUNCHPAD.pads, lens: LAUNCHPAD.lens, factory: LAUNCHPAD.factory },
      gotcha: "Always quote through SafeLaunchLensV2 instead of reimplementing curve tax math, and treat a launch as tradeable only once the floor API reports phase 'live' (a created-but-unarmed launch is invisible and has no supply loaded).",
      tools: ["launcher_tape", "quote_launch", "token_detail", "contracts"],
    },
    {
      key: "stock-lanes",
      name: "Tokenized stock lanes",
      category: "launchpad",
      what: "Five Robinhood-chain lanes (GME, NVDA, AAPL, SPCX, USO) and eleven Reality Protocol r-stock lanes on Arbitrum quote curves in tokenized equity instead of crypto, pricing through Chainlink equity feeds.",
      agentOpportunity: "A memecoin quoted in GME is exposure to both legs at once; creator fees accrue in the stock token. No other launchpad offers this pairing.",
      urls: ["https://www.stonkbrokers.cash/launcher"],
      gotcha: "Chainlink equity feeds publish nothing from Friday close to Monday 00:00 UTC, so stock-lane curves must not be traded or launched on weekends. Stock-token products are restricted for US persons.",
      tools: ["launcher_tape", "contracts"],
    },
    {
      key: "stonk-exchange",
      name: "Stonk Exchange (vDEX, powered by up.)",
      category: "dex",
      what: "ve(3,3) DEX: Velodrome-style v2 pools, Slipstream concentrated liquidity, gauges and weekly veUP emissions. $UP is the DEX token, $STONKBROKER is the governance token that directs emissions. Graduated launcher tokens receive gauges.",
      agentOpportunity: "Where graduated launcher tokens keep trading and where LP yield lives. An agent providing liquidity earns swap fees plus $UP emissions instead of the token subsidising its own depth.",
      urls: ["https://stonkbrokers.io"],
      tools: ["smart_lp", "pairs", "fee_breakdown"],
    },
    {
      key: "smart-lp",
      name: "Smart LP vaults",
      category: "dex",
      what: "Immutable automated market-making vaults over Uniswap v3 stock-token pools, marketed as volatility farming. Three strategies: single-sided ask ladder, full range, and balanced band. 10% performance fee on collected fees only, split between StockBooster and $STONKBROKER buybacks; a 0.1% withdraw fee stays in the vault.",
      agentOpportunity: "Deposit-and-forget market making for agents that do not want to run their own rebalancer. The vault fleet's TVL and fee take are readable, so an agent can pick the vault whose band matches its view.",
      urls: ["https://stonkbrokers.io"],
      gotcha: "Vaults exist on Robinhood Chain only. The registry and lens have no code on Arbitrum One.",
      tools: ["smart_lp"],
    },
    {
      key: "safety-deposit-box",
      name: "Safety Deposit Box",
      category: "locker",
      what: "The ecosystem's permanent liquidity locker: five desks (Uniswap v3 locker, v4 locker, up. CL locker, up. v2 locker, ERC-20 vesting). Fee mode is fixed at lock time (0.5% upfront or 20% of swap fees). Lock styles are hard lock, linear vesting or permanent, and locker protocol fees route through an ownerless Clock In router, 90% community and 10% protocol.",
      agentOpportunity: "The reason launcher tokens are structurally safer to trade than ordinary curve tokens: every graduated pool's LP is locked with no unlock and no admin key. An agent pricing rug risk can verify the lock rather than trusting a claim.",
      urls: ["https://stonkbrokers.io"],
      gotcha: "The lock NFT still collects the pool's fee share for the creator; locked liquidity does not mean the creator earns nothing.",
      tools: ["fee_breakdown", "launcher_tape"],
    },
    {
      key: "broker-nfts",
      name: "Broker NFTs, Anvil AMM and Clock In",
      category: "nft",
      what: "4,444 pixel-art broker NFTs, among the first ERC-6551 token-bound-wallet collections, each TBA seeded with a random Robinhood stock token at mint. Anvil is the NFT AMM (flat 666,666 $STONKBROKER plus an ETH fee per broker, and loans against a broker at 15% APR). Activation tiers are paid in $STONKBROKER with 50% burned; Clock In v2 lets each activated broker elect up to three payout tokens and any wallet can crank the payout round.",
      agentOpportunity: "Two agent jobs: arbitrage the Anvil AMM against OpenSea, and crank Clock In rounds for the tip when the ETH bar fills. Both are permissionless.",
      urls: ["https://stonkbrokers.io", "https://opensea.io"],
      gotcha: "Activation clears on transfer, so a bought broker is not an activated broker. Stock-token play is unavailable to US persons.",
      tools: ["nft_market"],
    },
    {
      key: "opening-bell",
      name: "Opening Bell buybacks and the Buyback Bar",
      category: "game",
      what: "A slice of factory-curve fees charges a public Buyback Bar. DERP's VRNG picks both the moment and the target token, with odds weighted by fee contribution; anyone can Clock In to ring the bell and earn a tip while the whole bar market-buys the drawn token.",
      agentOpportunity: "A permissionless keeper job with a public tip, plus a predictable buy-pressure event an agent can position around once the bar is near full.",
      urls: ["https://stonkbrokers.wtf"],
      tools: ["fee_breakdown", "brokertools"],
    },
    {
      key: "nightshades",
      name: "Nightshades",
      category: "game",
      what: `A survival game by Meebco Labs and Clutch Markets. Four faction tokens (${NIGHTSHADES_FACTIONS.map((f) => `$${f.symbol}`).join(", ")}) each trade in a protocol-owned Uniswap v4 pool against WETH at a 1% fee, hooked by NightHook. Once a day The Night strikes: Chainlink VRF picks the survivors, 20-80% of every struck faction's pool liquidity is withdrawn and sold into its own pool, and that ETH plus the boost pot lands in the survivors' pools.`,
      agentOpportunity: "A genuinely new game-theoretic market: daily VRF-resolved redistribution between four pools, with the whole state readable on-chain before each Night. Roughly a 31% chance per faction of surviving a Night.",
      urls: [NIGHTSHADES.site, NIGHTSHADES.nightpaper, NIGHTSHADES.tradePage],
      gotcha: "Trading halts during a Night and reopens at Sunrise with a 99% anti-snipe tax that decays to zero over 60 minutes on buys and sells alike. Pools are EOA-only.",
      tools: ["nightshades"],
    },
    {
      key: "special-projects",
      name: "Special Projects (incubator)",
      category: "index",
      what: "The incubated-team roster: every Special Projects token is paired to $STONKBROKER by liquidity, seeded at launch finalize, on top of its own base pairing. Independent teams with their own tokens and their own risk.",
      agentOpportunity: "Each new Special Project arrives with a fresh $STONKBROKER-paired pool, which is both a trading venue and a volume signal for the mission token.",
      urls: ["https://stonkbrokers.io"],
      tools: ["token_tape", "library_search"],
    },
    {
      key: "brokertools",
      name: "brokertools.info",
      category: "index",
      what: "Community index over the ecosystem: launch counts, wallet counters and protocol activity totals for Robinhood Chain.",
      agentOpportunity: "The quickest sanity check on ecosystem-wide activity before an agent commits capital.",
      urls: ["https://brokertools.info"],
      tools: ["brokertools"],
    },
    {
      key: "laura",
      name: "LAURA (this swarm)",
      category: "agent",
      what: "An autonomous agent swarm growing the StonkBrokers ecosystem toward a $1B $STONKBROKER market cap. Twenty-six agents run on a cycle: grading the mission, researching, launching tokens on both chains, trading the ecosystem within code-level caps, writing and deploying her own contracts, and publishing.",
      agentOpportunity: "Read her state and her knowledge library to skip weeks of integration work: verified wire formats, pad quirks, and what actually worked live. She is also a counterparty, a launch partner and a source of ecosystem volume.",
      urls: ["https://laura.stonkbrokers.io", "https://laura.stonkbrokers.io/mcp"],
      tools: ["laura_state", "laura_contracts", "library_search", "library_doc"],
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    summary: [
      "The StonkBrokers ecosystem on Robinhood Chain (4663) and Arbitrum One (42161): a bonding-curve launchpad with crypto and tokenized-stock quote lanes, a ve(3,3) DEX with automated market-making vaults, a permanent liquidity locker, an ERC-6551 NFT collection with its own AMM and payout engine, VRF-driven buyback and survival games, and an autonomous agent swarm (LAURA) operating inside it.",
      "Every entry below names what an agent can actually do with it, the addresses or APIs to talk to, and the mistake integrators usually make.",
    ].join(" "),
    entries,
  };
}

/* -------------------------------- lens quote ------------------------------ */

export interface QuoteResult {
  chain: LaunchChainKey;
  chainId: number;
  lane: string;
  pad: string;
  lens: string;
  launchId: string;
  side: "buy" | "sell";
  amountIn: string;
  amountOut: string;
  quoteSymbol: string;
  taxBps: number;
  taxPct: number;
  effectivePrice: string;
  note: string;
}

/**
 * Quotes a buy or a sell on a live curve through SafeLaunchLensV2 — the same
 * read the launcher UI uses, so the tax and curve math are the pad's own.
 */
export async function quoteLaunch(opts: {
  lane: string;
  launchId: string | number;
  side: "buy" | "sell";
  amountIn: string | number;
  seller?: string;
}): Promise<QuoteResult> {
  const lane = PAD_LANE_KEYS.find((l) => l === opts.lane) as PadLane | undefined;
  if (!lane) throw new Error(`unknown lane ${opts.lane}; call contracts for the lane list`);
  const chainKey = laneChain(lane).key;
  const pad = LAUNCHPAD.pads[lane] as `0x${string}`;
  const lens = LAUNCH_CHAINS[chainKey].lens as `0x${string}`;
  const id = BigInt(opts.launchId);
  const quoteMeta = QUOTE_TOKENS[lane];
  const quoteDecimals = quoteMeta?.decimals ?? 18;
  const quoteSymbol = quoteMeta?.symbol ?? LANE_INFO[lane].quote;
  const client = clientFor(chainKey);

  if (opts.side === "buy") {
    const amountIn = parseUnits(String(opts.amountIn), quoteDecimals);
    const [tokensOut, taxBps] = (await client.readContract({
      address: lens,
      abi: LENS_ABI,
      functionName: "quoteBuy",
      args: [pad, id, amountIn],
    })) as [bigint, bigint];
    const out = formatUnits(tokensOut, 18);
    return {
      chain: chainKey,
      chainId: LAUNCH_CHAINS[chainKey].chain.id,
      lane,
      pad,
      lens,
      launchId: String(id),
      side: "buy",
      amountIn: String(opts.amountIn),
      amountOut: out,
      quoteSymbol,
      taxBps: Number(taxBps),
      taxPct: Number(taxBps) / 100,
      effectivePrice: Number(out) > 0 ? String(Number(opts.amountIn) / Number(out)) : "0",
      note: `Spending ${opts.amountIn} ${quoteSymbol} returns ${out} tokens after a ${Number(taxBps) / 100}% curve tax. Quote is a live lens read, not a promise: the tax decays over time and the curve moves with every trade.`,
    };
  }

  const seller = (opts.seller ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(seller)) throw new Error("seller must be a 0x address");
  const tokensIn = parseUnits(String(opts.amountIn), 18);
  const [quoteOut, taxBps] = (await client.readContract({
    address: lens,
    abi: LENS_ABI,
    functionName: "quoteSell",
    args: [pad, id, seller, tokensIn],
  })) as [bigint, bigint];
  const out = formatUnits(quoteOut, quoteDecimals);
  return {
    chain: chainKey,
    chainId: LAUNCH_CHAINS[chainKey].chain.id,
    lane,
    pad,
    lens,
    launchId: String(id),
    side: "sell",
    amountIn: String(opts.amountIn),
    amountOut: out,
    quoteSymbol,
    taxBps: Number(taxBps),
    taxPct: Number(taxBps) / 100,
    effectivePrice: Number(opts.amountIn) > 0 ? String(Number(out) / Number(opts.amountIn)) : "0",
    note: `Selling ${opts.amountIn} tokens returns ${out} ${quoteSymbol} after a ${Number(taxBps) / 100}% tax. Pass your own address as seller: the pad prices some sells per wallet.`,
  };
}

/* ------------------------------ token detail ------------------------------ */

interface GridRow {
  token: string;
  name?: string;
  symbol?: string;
  creator?: string;
  quote?: string;
  priceUsd?: number;
  mcapUsd?: number;
  curvePct?: number;
  holderCount?: number;
  tradeCount?: number;
  volume24hUsd?: number;
  graduated?: boolean;
  safePhase?: string;
  safeHref?: string;
  safeId?: number;
  createdAt?: string;
}

/** Site lane key (the safeHref prefix) back to our lane and its chain. */
const LANE_BY_SITE_KEY = new Map<string, PadLane>(PAD_LANE_KEYS.map((l) => [SITE_LANE_KEY[l], l]));

/**
 * Chain, lane and pad launch id for a grid row. The grid APIs serve rows from
 * BOTH chains regardless of which one you ask (verified 2026-09-15: the
 * Robinhood grid returned the Arbitrum row for POSTCARD), and no row carries a
 * chain id. The only reliable signal is safeHref's lane prefix in
 * `/safe-launch/token/<siteLaneKey>-<symbol>-<launchId>`, which also carries
 * the pad's real launch id — `safeId` is the site-global floor id, offset into
 * a per-lane band, and passing it to the pad would read the wrong launch.
 */
function locateGridRow(row: GridRow): { lane: string | null; chain: LaunchChainKey; launchId: string | null; floorId: number | null } {
  const m = /^\/safe-launch\/token\/([a-z0-9]+)-.*-(\d+)$/.exec(row.safeHref ?? "");
  const siteKey = m ? m[1] : null;
  /* Only arbweth is one of OUR lanes; the other twenty Arbitrum pads are
     reference data, so match the full Arbitrum table too rather than
     mislabelling an arbusdc row as Robinhood. */
  const ourLane = siteKey ? (LANE_BY_SITE_KEY.get(siteKey) ?? null) : null;
  const arbLane = siteKey ? (ARBITRUM_PADS.find((p) => p.lane === siteKey)?.lane ?? null) : null;
  const chain: LaunchChainKey = ourLane ? laneChain(ourLane).key : arbLane ? "arbitrum" : "robinhood";
  return {
    lane: ourLane ?? arbLane ?? siteKey,
    chain,
    launchId: m ? m[2] : null,
    floorId: row.safeId ?? null,
  };
}

function describeGridRow(row: GridRow): string {
  if (row.safePhase === "live") return "Live on the curve. Quote with quote_launch using the lane and launchId above before trading; never reimplement the tax math.";
  if (row.graduated) return "Graduated: the curve is done and the bonded pool is locked in the Safety Deposit Box. Trade it on the DEX pool, not the pad.";
  return `Phase ${row.safePhase ?? "unknown"} — not tradeable as a live curve right now.`;
}

/**
 * Resolves one launcher token against the launcher grids. Returns the row, the
 * chain it actually lives on, the lane and launch id to quote with, its trade
 * page and the explorer link, so an agent holding nothing but an address can
 * find out what it has.
 */
export async function launchTokenDetail(token: string): Promise<unknown> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("token must be a 0x address");
  const needle = token.toLowerCase();

  for (const key of ["robinhood", "arbitrum"] as LaunchChainKey[]) {
    try {
      const res = await fetch(LAUNCH_CHAINS[key].gridApi, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { tokens?: GridRow[] };
      const row = (body.tokens ?? []).find((t) => (t.token ?? "").toLowerCase() === needle);
      if (!row) continue;

      const located = locateGridRow(row);
      const info = LAUNCH_CHAINS[located.chain];
      return {
        found: true,
        chain: located.chain,
        chainId: info.chain.id,
        chainLabel: info.label,
        lane: located.lane,
        launchId: located.launchId,
        floorId: located.floorId,
        token: row.token,
        name: row.name ?? null,
        symbol: row.symbol ?? null,
        creator: row.creator ?? null,
        quoteToken: row.quote ?? null,
        priceUsd: row.priceUsd ?? null,
        marketCapUsd: row.mcapUsd ?? null,
        curveProgressPct: row.curvePct ?? null,
        holderCount: row.holderCount ?? null,
        tradeCount: row.tradeCount ?? null,
        volume24hUsd: row.volume24hUsd ?? null,
        graduated: row.graduated ?? null,
        phase: row.safePhase ?? null,
        tradePage: row.safeHref ? `https://stonkbrokers.io${row.safeHref}` : null,
        explorer: `${info.explorer}/token/${row.token}`,
        createdAt: row.createdAt ?? null,
        note: describeGridRow(row),
        idNote: "launchId is the pad's own id (quote_launch takes this). floorId is the site-global row id and is NOT accepted by the pad.",
      };
    } catch {
      /* try the other grid */
    }
  }
  return {
    found: false,
    token,
    note: "Not a Stonk Launcher token on either chain's grid (or the grid API is unreachable). It may be an ordinary ERC-20; try holders for distribution.",
  };
}

/* --------------------------- arbitrum launcher ---------------------------- */

/** Every Arbitrum One pad lane with its quote token, plus the live Arbitrum tape. */
export async function arbitrumLauncher(): Promise<unknown> {
  const info = LAUNCH_CHAINS.arbitrum;
  let tokens: GridRow[] = [];
  let tapeError: string | null = null;
  try {
    const res = await fetch(info.gridApi, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const body = (await res.json()) as { tokens?: GridRow[] };
      tokens = body.tokens ?? [];
    } else {
      tapeError = `grid HTTP ${res.status}`;
    }
  } catch (err) {
    tapeError = String(err).slice(0, 160);
  }
  const arbRows = tokens.filter((t) => locateGridRow(t).chain === "arbitrum");

  return {
    chainId: info.chain.id,
    chainLabel: info.label,
    lens: info.lens,
    weth: info.weth,
    explorer: info.explorer,
    bondVenue: info.bondVenue,
    gridApi: info.gridApi,
    padCount: ARBITRUM_PADS.length,
    pads: ARBITRUM_PADS.map((p) => ({
      lane: p.lane,
      quoteSymbol: p.quoteSymbol,
      pad: p.pad,
      quoteToken: p.quote,
      quoteDecimals: p.decimals,
      usGated: p.usGated,
      deployLaneForLaura: p.lane === "arbweth",
    })),
    /* The grid serves rows from both chains whichever one you ask for, so
       filter to the ones whose lane really is an Arbitrum lane. */
    tape: {
      error: tapeError,
      count: arbRows.length,
      live: arbRows.filter((t) => t.safePhase === "live").length,
      graduated: arbRows.filter((t) => t.graduated).length,
      recent: arbRows.slice(0, 25).map((t) => {
        const located = locateGridRow(t);
        return {
          token: t.token,
          symbol: t.symbol ?? null,
          name: t.name ?? null,
          lane: located.lane,
          launchId: located.launchId,
          phase: t.safePhase ?? null,
          marketCapUsd: t.mcapUsd ?? null,
          curveProgressPct: t.curvePct ?? null,
          holderCount: t.holderCount ?? null,
          volume24hUsd: t.volume24hUsd ?? null,
          tradePage: t.safeHref ? `https://stonkbrokers.io${t.safeHref}` : null,
        };
      }),
    },
    rules: [
      "Same StonkSafeLaunchpadV2 ABI as Robinhood Chain: createLaunch then arm, quotes through the lens above.",
      "bondVenue must be 1 (Uniswap v3). There is no StonkUp locker on Arbitrum and bondVenue 0 reverts BadParam().",
      "The WETH lane takes native ETH through buyEth; the other lanes need an ERC-20 approve of their quote token first.",
      "The r-prefixed lanes quote Reality Protocol tokenized stocks and are gated for US persons.",
    ],
  };
}

/* -------------------------------- nightshades ----------------------------- */

/** Static Nightshades reference: factions, venues and the rules that gate a trade. */
export function nightshadesReference() {
  return {
    game: "Nightshades",
    by: "Meebco Labs x Clutch Markets",
    chainId: ROBINHOOD_CHAIN.id,
    site: NIGHTSHADES.site,
    nightpaper: NIGHTSHADES.nightpaper,
    tradePage: NIGHTSHADES.tradePage,
    factions: NIGHTSHADES_FACTIONS.map((f) => ({ id: f.id, name: f.name, symbol: f.symbol, token: f.token, launchId: f.launchId })),
    mechanics: [
      "Each faction token trades in its own protocol-owned Uniswap v4 pool against WETH at a 1% fee, hooked by NightHook.",
      "Once a day The Night strikes: Chainlink VRF picks the survivors (usually one of four, sometimes two).",
      "20-80% of every struck faction's pool liquidity is withdrawn and the struck tokens are sold into their own pool; that ETH plus the boost pot is added to the survivors' pools.",
      "Trading halts for the Night, then reopens at Sunrise with a 99% anti-snipe tax decaying to zero over 60 minutes on buys AND sells.",
      "A struck faction is not eliminated and can be struck again.",
    ],
    agentNotes: [
      "Pools are EOA-only: a contract cannot swap, so an agent must trade from a plain wallet.",
      "Never swap while a Night is resolving or while the Sunrise tax is above your tolerance; the tax applies to exits too.",
      "Holding through a Night is a wager with roughly a 31% chance per faction of surviving.",
    ],
  };
}
