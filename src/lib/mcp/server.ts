import { NextRequest } from "next/server";
import { GET as launcherFeed } from "@/app/api/feeds/launcher/route";
import { GET as tokensFeed } from "@/app/api/feeds/tokens/route";
import { GET as pairsFeed } from "@/app/api/feeds/pairs/route";
import { GET as holdersFeed } from "@/app/api/feeds/holders/route";
import { GET as smartLpFeed } from "@/app/api/feeds/smartlp/route";
import { GET as brokertoolsFeed } from "@/app/api/feeds/brokertools/route";
import { GET as feeBreakdownFeed } from "@/app/api/feeds/fee-breakdown/route";
import { GET as llamaChainsFeed } from "@/app/api/feeds/llama-chains/route";
import { GET as nftTrendsFeed } from "@/app/api/feeds/nft-trends/route";
import { GET as nftBuysFeed } from "@/app/api/feeds/nft-buys/route";
import { GET as defillamaFeed } from "@/app/api/feeds/defillama/route";
import { GET as polymarketFeed } from "@/app/api/feeds/polymarket/route";
import { GET as forgeFeed } from "@/app/api/forge/route";
import {
  arbitrumLauncher,
  ecosystemMap,
  launchTokenDetail,
  nightshadesReference,
  quoteLaunch,
} from "@/lib/mcp/ecosystem";
import { fetchNightshadesState } from "@/lib/launchpad/nightshades";
import { ARBITRUM_PADS, LAUNCH_CHAINS, LAUNCHPAD, PAD_LANE_KEYS, ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { DEFAULT_SETTINGS } from "@/lib/swarm/roster";
import { libraryDocs } from "@/lib/swarm/library";
import { isViewerMode } from "@/lib/viewer/mode";
import { readSnapshot } from "@/lib/viewer/store";
import { loadState } from "@/lib/store";
import { missionStatus } from "@/lib/mission-status";
import type { LaunchProposal, MetricsSnapshot } from "@/lib/types";

/**
 * LAURA's MCP server (Model Context Protocol, Streamable HTTP transport,
 * stateless JSON-RPC 2.0). This is the layer that lets OTHER agents - trading
 * bots, research assistants, autonomous market makers - read Robinhood Chain
 * and the Stonk Launcher through one standard interface, so that more agentic
 * traders can find the ecosystem, price it, and route flow into it.
 *
 * Boundaries, by design:
 *  - Read only. There is no tool that signs, spends, launches, or posts.
 *    Agents that want to trade bring their own wallet; the `contracts` tool
 *    and the manifest tell them exactly which addresses to talk to.
 *  - No secrets. Every tool proxies data that is already public on this
 *    console (/api/feeds/*, /api/state, /library). The server ships on the
 *    public viewer (laura.stonkbrokers.io/api/mcp) and on the operator's
 *    daemon alike.
 *  - Stateless. No sessions, no SSE stream to keep alive; every POST is one
 *    request, one response. Clients that need `Mcp-Session-Id` get none and
 *    must treat the server as stateless (the spec allows this).
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "stonkbrokers-ecosystem";
export const MCP_SERVER_VERSION = "2.0.0";

export const MCP_INSTRUCTIONS = [
  "This is the full Model Context Protocol server for the StonkBrokers ecosystem on Robinhood Chain (chain id 4663) and Arbitrum One (42161), operated by LAURA, the autonomous agent swarm that grows it.",
  "Coverage: the Stonk Launcher bonding-curve pads on both chains (crypto and tokenized-stock quote lanes), live lens quotes for any curve, single-token lookups, the ve(3,3) Stonk Exchange and its Smart LP vaults, the Safety Deposit Box locker, $STONKBROKER market depth and holders, protocol fee and revenue breakdowns, the ERC-6551 broker NFT collection and its AMM, the Nightshades survival game, chain-level comparisons against all of crypto, contracts LAURA wrote herself, and her whole knowledge library.",
  "Start with ecosystem_map: it names every protocol here, what an agent can actually do with each one, the addresses and APIs to talk to, and the mistake integrators usually make.",
  "Nothing here signs or spends. Bring your own wallet. Always quote through quote_launch (SafeLaunchLensV2) instead of reimplementing curve tax math, and treat a launch as tradeable only once its phase reads 'live'.",
  "Two standing traps: tokenized-stock lanes price through Chainlink equity feeds that go dark from Friday close to Monday 00:00 UTC, and Arbitrum pads only accept bondVenue 1 (Uniswap v3).",
  "Every trade on a launcher curve pays protocol revenue that the ecosystem routes toward $STONKBROKER, so an agent trading here is already inside the flywheel.",
].join(" ");

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

async function feedJson(handler: () => Promise<Response>): Promise<unknown> {
  const res = await handler();
  const body = (await res.json()) as unknown;
  if (!res.ok) throw new Error(typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `feed HTTP ${res.status}`);
  return body;
}

function contractsPayload() {
  return {
    chain: {
      id: ROBINHOOD_CHAIN.id,
      name: ROBINHOOD_CHAIN.name,
      rpc: ROBINHOOD_CHAIN.rpcUrls.default.http[0],
      explorer: ROBINHOOD_CHAIN.blockExplorers.default.url,
      nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
    },
    stonkbroker: {
      token: DEFAULT_SETTINGS.tokenAddress,
      explorer: `${ROBINHOOD_CHAIN.blockExplorers.default.url}/token/${DEFAULT_SETTINGS.tokenAddress}`,
      note: "Protocol revenue from every Stonk Launcher lane accrues to $STONKBROKER holders.",
    },
    launcher: {
      pads: LAUNCHPAD.pads,
      lanes: PAD_LANE_KEYS,
      lens: LAUNCHPAD.lens,
      factory: LAUNCHPAD.factory,
      gridApi: LAUNCHPAD.gridApi,
      floorApi: LAUNCHPAD.floorApi,
      abi: "https://www.stonkbrokers.cash/docs (StonkSafeLaunchpadV2.abi.json, Trading App Integration)",
      rules: [
        "Quote buys and sells through SafeLaunchLensV2 (lens); never reimplement the curve tax math.",
        "A launch is user-visible only once the floor API reports phase 'live'.",
        "Stock-quoted lanes (gme, nvda, aapl, spcx, uso) price through Chainlink equity feeds that go dark from Friday close to Monday 00:00 UTC; do not trade those lanes on weekends.",
        "Every pad has launchFeeWei == 0; the curve tax and post-graduation tax are the fee model.",
        "The launcher also runs on Arbitrum One (chain 42161) with the same ABI: 21 pads, lens 0x7376f9dC6432434D611488CB3E852071ed29E276, WETH lane takes native ETH via buyEth, bonded pools are Uniswap v3 (1%). LAURA deploys there through her arbweth lane.",
      ],
      arbitrumOne: {
        chainId: LAUNCH_CHAINS.arbitrum.chain.id,
        lens: LAUNCH_CHAINS.arbitrum.lens,
        weth: LAUNCH_CHAINS.arbitrum.weth,
        gridApi: LAUNCH_CHAINS.arbitrum.gridApi,
        explorer: LAUNCH_CHAINS.arbitrum.explorer,
        pads: ARBITRUM_PADS.map((p) => ({ lane: p.lane, quote: p.quoteSymbol, pad: p.pad, quoteToken: p.quote, decimals: p.decimals })),
      },
    },
    ui: {
      launcher: "https://www.stonkbrokers.cash/launcher",
      brokertools: "https://brokertools.info",
      laura: "https://laura.stonkbrokers.io",
    },
  };
}

function summarizeMetrics(m: MetricsSnapshot | undefined | null) {
  if (!m) return null;
  return {
    ts: m.ts,
    priceUsd: m.priceUsd,
    priceChange24hPct: m.priceChange24hPct,
    marketCapUsd: m.marketCapUsd,
    liquidityUsd: m.liquidityUsd,
    tokenDexVolume24hUsd: m.tokenDexVolume24hUsd,
    protocolFees24hUsd: m.protocolFees24hUsd,
    protocolRevenue24hUsd: m.protocolRevenue24hUsd,
    protocolVolume24hUsd: m.protocolVolume24hUsd,
    ecosystemVolume24hUsd: m.ecosystemVolume24hUsd ?? null,
    ecosystemVolumeBreakdown:
      m.ecosystemVolumeVersion === 2
        ? {
            stonkbrokerUsd: m.tokenDexVolume24hUsd,
            specialProjectsUsd: m.specialProjectsVolume24hUsd ?? 0,
            launcherTokensUsd: m.launcherTokensVolume24hUsd ?? 0,
            launcherTokenCount: m.launcherTokenCount ?? 0,
            smartLpShareUsd: m.smartLpAttributedVolume24hUsd ?? 0,
          }
        : null,
    protocolRevenueBreakdown:
      m.sdbFlowVersion === 1
        ? {
            llamaRevenue24hUsd: m.llamaRevenue24hUsd ?? 0,
            safetyDepositBoxFlow24hUsd: m.sdbFlow24hUsd ?? 0,
            safetyDepositBoxBrokersShare24hUsd: m.sdbBrokersShare24hUsd ?? 0,
            safetyDepositBoxProtocolWallet24hUsd: m.sdbProtocolWallet24hUsd ?? 0,
            note: "protocolRevenue24hUsd = DeFiLlama revenue + the brokers' share of Safety Deposit Box locker cuts (DeFiLlama books only the protocol-wallet slice).",
          }
        : null,
    tvlUsd: m.tvlUsd,
  };
}

function summarizeLaunch(l: LaunchProposal) {
  return {
    id: l.id,
    name: l.name,
    symbol: l.symbol,
    lane: l.lane,
    status: l.status,
    tokenAddress: l.tokenAddress,
    launchId: l.launchId,
    txHash: l.txHash,
    createdAt: l.createdAt,
    explorer: l.tokenAddress ? `${ROBINHOOD_CHAIN.blockExplorers.default.url}/token/${l.tokenAddress}` : null,
  };
}

/**
 * Public snapshot of LAURA herself: mission progress, the latest metrics, the
 * roster's size, and the tokens she has launched. Same data the console shows
 * to the world; nothing from settings or credentials.
 */
async function lauraStatePayload(): Promise<unknown> {
  if (isViewerMode()) {
    const snap = await readSnapshot();
    if (!snap) return { ok: false, error: "No snapshot published yet." };
    const history = (snap.metricsHistory as MetricsSnapshot[] | undefined) ?? [];
    const launches = (snap.launches as LaunchProposal[] | undefined) ?? [];
    const agents = (snap.agents as { id: string; name: string; role: string }[] | undefined) ?? [];
    return {
      ok: true,
      mission: snap.mission ?? null,
      latest: summarizeMetrics(history.at(-1)),
      agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
      launches: launches.filter((l) => l.status === "deployed").slice(-25).map(summarizeLaunch),
    };
  }
  const state = await loadState();
  const latest = state.metricsHistory.at(-1) ?? null;
  return {
    ok: true,
    mission: missionStatus(state, latest),
    latest: summarizeMetrics(latest),
    agents: state.agents.filter((a) => !a.retiredAt).map((a) => ({ id: a.id, name: a.name, role: a.role })),
    launches: state.launches.filter((l) => l.status === "deployed").slice(-25).map(summarizeLaunch),
  };
}

function scoreDoc(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((s, t) => s + (lower.split(t).length - 1), 0);
}

function excerpt(text: string, terms: string[], width = 700): string {
  const lower = text.toLowerCase();
  const idx = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, idx - Math.floor(width / 3));
  const slice = text.slice(start, start + width).trim();
  return `${start > 0 ? "…" : ""}${slice}${start + width < text.length ? "…" : ""}`;
}

async function librarySearch(query: string, limit: number): Promise<unknown> {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 3).slice(0, 8);
  if (terms.length === 0) throw new Error("query needs at least one term of 3+ characters");
  const docs = await libraryDocs();
  const hits = docs
    .map((d) => ({ file: d.file, score: scoreDoc(d.text, terms), text: d.text }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((d) => ({ file: d.file, score: d.score, excerpt: excerpt(d.text, terms) }));
  return { query, hits, files: docs.map((d) => d.file) };
}

async function libraryDoc(file: string): Promise<unknown> {
  const docs = await libraryDocs();
  const doc = docs.find((d) => d.file === file);
  if (!doc) throw new Error(`no library doc named ${file}; call library_search to list files`);
  return { file: doc.file, text: doc.text };
}

const TOOLS: ToolDef[] = [
  {
    name: "ecosystem_map",
    description:
      "START HERE. The whole StonkBrokers ecosystem in one document: every protocol on Robinhood Chain and Arbitrum One (launchpad, tokenized-stock lanes, ve(3,3) DEX, Smart LP vaults, Safety Deposit Box locker, broker NFTs and the Anvil AMM, Opening Bell buybacks, Nightshades, Special Projects, brokertools, LAURA herself), what each one does, what an agent can actually DO with it today, its addresses and APIs, the mistake integrators usually make, and which tool on this server reads it.",
    inputSchema: NO_ARGS,
    run: async () => ecosystemMap(),
  },
  {
    name: "quote_launch",
    description:
      "Live SafeLaunchLensV2 quote for a buy or a sell on any Stonk Launcher curve, on either chain. Returns tokens out (or quote out), the exact tax in bps at this moment, the effective price and the pad and lens used. This is the correct way to price a curve trade: the tax decays minute by minute and the curve moves with every trade, so never reimplement the math.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Quote lane, e.g. weth, stonk, usdg, gme, nvda, aapl, spcx, uso, arbweth. Call contracts or ecosystem_map for the list." },
        launchId: { type: "string", description: "The pad's launch id (the trailing number on a /safe-launch/token/<lane>-<symbol>-<id> page, or safeId from launcher_tape)." },
        side: { type: "string", enum: ["buy", "sell"], description: "buy spends the quote token, sell spends launch tokens" },
        amountIn: { type: "string", description: "Human amount in: quote tokens for a buy (e.g. \"0.05\"), launch tokens for a sell (e.g. \"250000\")." },
        seller: { type: "string", description: "For a sell, the wallet doing the selling (the pad prices some sells per wallet). Defaults to the zero address.", pattern: "^0x[0-9a-fA-F]{40}$" },
      },
      required: ["lane", "launchId", "side", "amountIn"],
      additionalProperties: false,
    },
    run: (args) => {
      const lane = typeof args.lane === "string" ? args.lane : "";
      const launchId = typeof args.launchId === "string" || typeof args.launchId === "number" ? args.launchId : "";
      const side = args.side === "sell" ? "sell" : "buy";
      const amountIn = typeof args.amountIn === "string" || typeof args.amountIn === "number" ? args.amountIn : "";
      if (!lane || launchId === "" || amountIn === "") throw new Error("lane, launchId, side and amountIn are required");
      return quoteLaunch({ lane, launchId, side, amountIn, seller: typeof args.seller === "string" ? args.seller : undefined });
    },
  },
  {
    name: "token_detail",
    description:
      "Resolve one token address against both chains' launcher grids: name, symbol, creator, quote token, price and market cap, curve progress, holder and trade counts, 24h volume, phase (waiting/live/graduated), launch id, trade page and explorer link. Use it when all you have is an address and you need to know what it is and whether it is tradeable.",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string", description: "0x token address", pattern: "^0x[0-9a-fA-F]{40}$" } },
      required: ["token"],
      additionalProperties: false,
    },
    run: (args) => {
      if (typeof args.token !== "string") throw new Error("token is required");
      return launchTokenDetail(args.token);
    },
  },
  {
    name: "arbitrum_launcher",
    description:
      "The Stonk Launcher on Arbitrum One (chain 42161): all 21 pad lanes with their quote tokens and decimals, the lens, canonical WETH, the bond venue, plus the live Arbitrum tape (counts of live and graduated launches and the most recent rows with trade pages). The same pad ABI as Robinhood Chain on a chain most agents are already funded on.",
    inputSchema: NO_ARGS,
    run: arbitrumLauncher,
  },
  {
    name: "nightshades",
    description:
      "The Nightshades survival game (Meebco Labs x Clutch Markets): live game clock and per-faction state for the four faction tokens, each in its own protocol-owned Uniswap v4 pool against WETH, plus the static reference (factions, token and NFT addresses, router, quoter, vault, hook and manager) and the rules that gate a trade. Once a day Chainlink VRF strikes: struck pools lose 20-80% of liquidity into their own price, survivors receive it, trading halts, then reopens at Sunrise behind a 99% tax decaying to zero over an hour.",
    inputSchema: NO_ARGS,
    run: async () => {
      const reference = nightshadesReference();
      try {
        const live = await fetchNightshadesState();
        return { reference, live };
      } catch (err) {
        return { reference, live: null, liveError: `on-chain read failed: ${String(err).slice(0, 160)}` };
      }
    },
  },
  {
    name: "nft_market",
    description:
      "Robinhood Chain NFT market: collection-level trends (floor, volume and change) plus the recent buy tape. Covers the 4,444 ERC-6551 broker NFTs and the other collections on the chain. The broker collection trades both on OpenSea and through the Anvil AMM, so the two venues can disagree.",
    inputSchema: NO_ARGS,
    run: async () => ({ trends: await feedJson(nftTrendsFeed), buys: await feedJson(nftBuysFeed) }),
  },
  {
    name: "protocol_economics",
    description:
      "StonkBrokers protocol economics from DeFiLlama: TVL, fees and revenue with their history, as the rest of the market sees them. Pair it with fee_breakdown for the per-lane and per-venue split of where those fees are actually generated.",
    inputSchema: NO_ARGS,
    run: () => feedJson(defillamaFeed),
  },
  {
    name: "prediction_markets",
    description:
      "Live Polymarket questions by 24h volume: the external event surface LAURA's swarm reads each cycle. Useful for an agent that wants to pair an on-chain launch or trade with a real-world event resolving today.",
    inputSchema: NO_ARGS,
    run: () => feedJson(polymarketFeed),
  },
  {
    name: "launcher_tape",
    description:
      "Stonk Launcher tape: recent launches on every pad lane with phase (waiting/live/graduated), quote lane, current market cap and 24h activity. The primary discovery surface for new tokens on Robinhood Chain.",
    inputSchema: NO_ARGS,
    run: () => feedJson(launcherFeed),
  },
  {
    name: "token_tape",
    description:
      "Market tape: DexScreener marks for $STONKBROKER and the largest bonded launcher tokens, with quote-side vetting (only canonical WETH/USDG/STONK quotes with real depth are shown).",
    inputSchema: NO_ARGS,
    run: () => feedJson(tokensFeed),
  },
  {
    name: "pairs",
    description: "Every $STONKBROKER trading pair on Robinhood Chain with price, liquidity and 24h volume per venue.",
    inputSchema: NO_ARGS,
    run: () => feedJson(pairsFeed),
  },
  {
    name: "holders",
    description:
      "Holder count and lifetime transfer count for a Robinhood Chain token. Defaults to $STONKBROKER; pass any 0x address, for example a launcher token, to check distribution before trading it.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "0x-prefixed token address (optional, defaults to $STONKBROKER)", pattern: "^0x[0-9a-fA-F]{40}$" },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const token = typeof args.token === "string" ? args.token : null;
      const url = new URL("http://mcp.local/api/feeds/holders");
      if (token) url.searchParams.set("token", token);
      return feedJson(() => holdersFeed(new NextRequest(url)));
    },
  },
  {
    name: "smart_lp",
    description: "Smart LP feed: the concentrated liquidity positions and ranges on the main $STONKBROKER pools, useful for reading where depth actually sits before sizing a trade.",
    inputSchema: NO_ARGS,
    run: () => feedJson(smartLpFeed),
  },
  {
    name: "brokertools",
    description: "brokertools.info ecosystem counters: indexed launches, wallets, and protocol activity totals for Robinhood Chain.",
    inputSchema: NO_ARGS,
    run: () => feedJson(brokertoolsFeed),
  },
  {
    name: "fee_breakdown",
    description: "Where protocol fees come from: per-lane and per-venue fee and revenue breakdown for the Stonkbrokers protocol.",
    inputSchema: NO_ARGS,
    run: () => feedJson(feeBreakdownFeed),
  },
  {
    name: "chain_compare",
    description:
      "Robinhood Chain against all of crypto (DeFiLlama): TVL rank and share among all chains with 7d/30d change, DEX volume and fees on the chain with their share of all-crypto totals, the top protocols on the chain, and where StonkBrokers ranks among them by volume, fees and TVL.",
    inputSchema: NO_ARGS,
    run: () => feedJson(llamaChainsFeed),
  },
  {
    name: "laura_contracts",
    description:
      "Smart contracts LAURA wrote and deployed herself on Robinhood Chain (verified source): the flagship Ownership Market (buy and sell ownership of any Ownable contract, any token, 1% fee, escrowed ownership, anyone executes delivery) and Anvil's small utility contracts built from what people on X asked for. Each entry carries the address, explorer link, ABI, how-to-use text and status. Anyone can host a frontend for these; the guide for the Ownership Market is docs/OWNERSHIP-MARKET.md in the repo.",
    inputSchema: NO_ARGS,
    run: () => feedJson(forgeFeed),
  },
  {
    name: "contracts",
    description:
      "The exact addresses an agent needs on Robinhood Chain: chain id and RPC, $STONKBROKER, every Stonk Launcher pad by quote lane, the SafeLaunchLensV2 quoting lens, the factory, the public launcher APIs, and the trading rules that keep you out of trouble (weekend stock lanes, lens-only quoting).",
    inputSchema: NO_ARGS,
    run: async () => contractsPayload(),
  },
  {
    name: "library_search",
    description:
      "Full-text search over LAURA's knowledge library: how the launcher works, verified integration wire formats, the ecosystem's projects, learnings from live operation. Returns ranked excerpts and the list of doc files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 3, description: "Search terms" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: (args) => {
      if (typeof args.query !== "string") throw new Error("query is required");
      const limit = typeof args.limit === "number" ? Math.min(10, Math.max(1, Math.floor(args.limit))) : 5;
      return librarySearch(args.query, limit);
    },
  },
  {
    name: "library_doc",
    description: "Full text of one library doc by file name (see library_search for the file list).",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string", description: "Doc file name, e.g. 30-integrations.md" } },
      required: ["file"],
      additionalProperties: false,
    },
    run: (args) => {
      if (typeof args.file !== "string" || !/^[\w.-]+\.md$/.test(args.file)) throw new Error("file must be a .md file name");
      return libraryDoc(args.file);
    },
  },
  {
    name: "laura_state",
    description:
      "LAURA's public state: mission progress toward the $1B $STONKBROKER market cap, the latest metrics snapshot, the active roster, and the tokens she has launched through the Stonk Launcher (with addresses).",
    inputSchema: NO_ARGS,
    run: lauraStatePayload,
  },
];

interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string>;
}

const RESOURCES: ResourceDef[] = [
  {
    uri: "stonkbrokers://ecosystem",
    name: "StonkBrokers ecosystem map",
    description: "Every protocol in the ecosystem with its addresses, APIs, what an agent can do with it, and the usual integration trap.",
    mimeType: "application/json",
    read: async () => JSON.stringify(ecosystemMap(), null, 2),
  },
  {
    uri: "laura://contracts",
    name: "Contracts and trading rules (both chains)",
    description: "Chain ids and RPCs, $STONKBROKER, every launcher pad by quote lane on Robinhood Chain and Arbitrum One, the lens, the factory, public APIs and the rules that keep an integrator out of trouble.",
    mimeType: "application/json",
    read: async () => JSON.stringify(contractsPayload(), null, 2),
  },
  {
    uri: "laura://nightshades",
    name: "Nightshades reference",
    description: "Factions, token and NFT addresses, router, quoter, vault, hook and manager, plus the Night and Sunrise rules that gate any trade.",
    mimeType: "application/json",
    read: async () => JSON.stringify(nightshadesReference(), null, 2),
  },
  {
    uri: "laura://for-agents",
    name: "For agents: how to participate in the StonkBrokers ecosystem",
    description: "Plain-language onboarding for autonomous traders and builders joining Robinhood Chain via Stonk Launcher.",
    mimeType: "text/markdown",
    read: async () => (await libraryDocs()).find((d) => d.file === "30-integrations.md")?.text ?? "See laura://contracts.",
  },
];

const PROMPTS = [
  {
    name: "onboard_agent",
    description: "Orient an agent that has never touched this ecosystem: what exists, what it can do, and the three rules that stop it losing money on the first trade.",
    arguments: [],
  },
  {
    name: "scan_launcher",
    description: "Scan the Stonk Launcher tape on both chains for tokens worth a closer look and explain the risks per lane.",
    arguments: [],
  },
  {
    name: "size_a_trade",
    description: "Given a launcher token address, pull its detail, holders, pair depth and a real lens quote, then reason about position size.",
    arguments: [{ name: "token", description: "0x token address", required: true }],
  },
  {
    name: "find_agent_edge",
    description: "Survey the whole ecosystem for the permissionless jobs an autonomous agent can actually run today, and rank them by how readable the edge is.",
    arguments: [],
  },
];

function promptMessages(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "onboard_agent":
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: "Call ecosystem_map, then contracts. Summarise for an autonomous agent with its own wallet: which protocols it can interact with today, which chain each lives on, and what a first useful action would be on each. Then state plainly the three rules that matter most before any trade (quote through the lens, a launch is only tradeable at phase 'live', tokenized-stock lanes are dark from Friday close to Monday 00:00 UTC). Do not propose a trade in this answer.",
          },
        },
      ];
    case "scan_launcher":
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: "Call launcher_tape, arbitrum_launcher and token_tape. List the tokens that are live with real quote-side depth, note which chain and lane each trades on, flag stock-quoted lanes if it is a weekend, and explain the graduation and tax mechanics from library_search('curve tax graduation') before suggesting any action.",
          },
        },
      ];
    case "size_a_trade":
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: `For token ${String(args.token ?? "")}: call token_detail with that address, then holders, pairs and smart_lp. If it is a live curve, call quote_launch with its lane and launch id at two sizes to read the tax and the slippage. Reason about distribution, real depth on the quote side and the current tax, then propose a position size that would not move the pool more than 1%.`,
          },
        },
      ];
    case "find_agent_edge":
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: "Call ecosystem_map, nightshades, nft_market, protocol_economics and brokertools. Identify the permissionless jobs an autonomous agent could run here today (keeper cranks, AMM-vs-marketplace arbitrage, curve market making, VRF-event positioning, liquidity provision) and rank them by how directly the edge is readable on-chain rather than guessed. For each, name the exact tool or contract call that would confirm the opportunity, and name what would make it a bad idea.",
          },
        },
      ];
    default:
      return null;
  }
}

function ok(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function isRequest(v: unknown): v is JsonRpcRequest {
  return typeof v === "object" && v !== null && (v as { jsonrpc?: unknown }).jsonrpc === "2.0" && typeof (v as { method?: unknown }).method === "string";
}

async function handleOne(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const params = (typeof req.params === "object" && req.params !== null ? req.params : {}) as Record<string, unknown>;

  try {
    switch (req.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          instructions: MCP_INSTRUCTIONS,
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const name = params.name;
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return fail(id, INVALID_PARAMS, `unknown tool ${String(name)}`);
        const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        try {
          const result = await tool.run(args);
          return ok(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
        } catch (err) {
          return ok(id, { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
        }
      }
      case "resources/list":
        return ok(id, { resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })) });
      case "resources/read": {
        const res = RESOURCES.find((r) => r.uri === params.uri);
        if (!res) return fail(id, INVALID_PARAMS, `unknown resource ${String(params.uri)}`);
        return ok(id, { contents: [{ uri: res.uri, mimeType: res.mimeType, text: await res.read() }] });
      }
      case "resources/templates/list":
        return ok(id, { resourceTemplates: [] });
      case "prompts/list":
        return ok(id, { prompts: PROMPTS });
      case "prompts/get": {
        const messages = promptMessages(String(params.name), (params.arguments as Record<string, unknown> | undefined) ?? {});
        if (!messages) return fail(id, INVALID_PARAMS, `unknown prompt ${String(params.name)}`);
        return ok(id, { messages });
      }
      default:
        if (isNotification) return null;
        return fail(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return fail(id, INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Handle one HTTP POST body. Returns the JSON-RPC response(s), or null when
 * the body held only notifications (the transport answers 202 with no body).
 */
export async function handleMcpBody(raw: string): Promise<{ status: number; body: JsonRpcResponse | JsonRpcResponse[] | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: fail(null, PARSE_ERROR, "invalid JSON") };
  }
  const batch = Array.isArray(parsed);
  const items = batch ? (parsed as unknown[]) : [parsed];
  if (items.length === 0) return { status: 400, body: fail(null, INVALID_REQUEST, "empty batch") };

  const out: JsonRpcResponse[] = [];
  for (const item of items) {
    if (!isRequest(item)) {
      out.push(fail(null, INVALID_REQUEST, "not a JSON-RPC 2.0 request"));
      continue;
    }
    const res = await handleOne(item);
    if (res) out.push(res);
  }
  if (out.length === 0) return { status: 202, body: null };
  return { status: 200, body: batch ? out : out[0] };
}

/** Tool catalogue for the human-readable docs and the manifest. */
export function mcpToolCatalogue(): { name: string; description: string }[] {
  return TOOLS.map(({ name, description }) => ({ name, description }));
}

/**
 * How the tools group on the public /mcp page and in llms.txt. A tool missing
 * from this map still renders, under "other", so adding a tool can never
 * silently drop it from the docs.
 */
const TOOL_GROUPS: { group: string; blurb: string; tools: string[] }[] = [
  {
    group: "Orientation",
    blurb: "What exists, where it lives, and the addresses to talk to.",
    tools: ["ecosystem_map", "contracts", "laura_state"],
  },
  {
    group: "Trade a curve",
    blurb: "Price and vet a bonding-curve trade on either chain.",
    tools: ["quote_launch", "token_detail", "launcher_tape", "arbitrum_launcher", "holders"],
  },
  {
    group: "Market depth",
    blurb: "Where liquidity actually sits before you size anything.",
    tools: ["token_tape", "pairs", "smart_lp"],
  },
  {
    group: "Protocol economics",
    blurb: "Fees, revenue and how the chain compares to all of crypto.",
    tools: ["protocol_economics", "fee_breakdown", "chain_compare", "brokertools"],
  },
  {
    group: "Games and collectibles",
    blurb: "The permissionless-keeper and arbitrage surfaces.",
    tools: ["nightshades", "nft_market", "prediction_markets"],
  },
  {
    group: "LAURA's own work",
    blurb: "Contracts she wrote and everything she has learned running live.",
    tools: ["laura_contracts", "library_search", "library_doc"],
  },
];

export interface McpCatalogueGroup {
  group: string;
  blurb: string;
  tools: { name: string; description: string }[];
}

/** Grouped catalogue for the /mcp page and llms.txt. Every tool appears exactly once. */
export function mcpGroupedCatalogue(): McpCatalogueGroup[] {
  const seen = new Set<string>();
  const groups: McpCatalogueGroup[] = TOOL_GROUPS.map(({ group, blurb, tools }) => ({
    group,
    blurb,
    tools: tools
      .map((n) => TOOLS.find((t) => t.name === n))
      .filter((t): t is ToolDef => Boolean(t))
      .map(({ name, description }) => {
        seen.add(name);
        return { name, description };
      }),
  }));
  const rest = TOOLS.filter((t) => !seen.has(t.name)).map(({ name, description }) => ({ name, description }));
  if (rest.length > 0) groups.push({ group: "Other", blurb: "Everything else this server exposes.", tools: rest });
  return groups;
}

/** Resource and prompt catalogue for the docs page. */
export function mcpResourceCatalogue(): { uri: string; name: string; description: string; mimeType: string }[] {
  return RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
}

export function mcpPromptCatalogue(): { name: string; description: string }[] {
  return PROMPTS.map(({ name, description }) => ({ name, description }));
}

export function mcpToolCount(): number {
  return TOOLS.length;
}
