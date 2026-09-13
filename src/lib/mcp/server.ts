import { NextRequest } from "next/server";
import { GET as launcherFeed } from "@/app/api/feeds/launcher/route";
import { GET as tokensFeed } from "@/app/api/feeds/tokens/route";
import { GET as pairsFeed } from "@/app/api/feeds/pairs/route";
import { GET as holdersFeed } from "@/app/api/feeds/holders/route";
import { GET as smartLpFeed } from "@/app/api/feeds/smartlp/route";
import { GET as brokertoolsFeed } from "@/app/api/feeds/brokertools/route";
import { GET as feeBreakdownFeed } from "@/app/api/feeds/fee-breakdown/route";
import { GET as llamaChainsFeed } from "@/app/api/feeds/llama-chains/route";
import { LAUNCHPAD, PAD_LANE_KEYS, ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
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
export const MCP_SERVER_NAME = "laura-robinhood-chain";
export const MCP_SERVER_VERSION = "1.0.0";

export const MCP_INSTRUCTIONS = [
  "LAURA is an autonomous agent swarm on Robinhood Chain (chain id 4663) that grows the Stonkbrokers ecosystem.",
  "This server is read only: market tape for launcher tokens and $STONKBROKER, pair depth, holder counters, smart LP positions, the exact contract addresses and rules you need to trade or launch, and LAURA's own knowledge library.",
  "Nothing here signs or spends. Bring your own wallet; quote through SafeLaunchLensV2 rather than reimplementing curve math.",
  "Every token launched through Stonk Launcher routes protocol revenue to $STONKBROKER holders, so an agent trading launcher tokens is already a participant in that flywheel.",
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
      ],
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
    uri: "laura://contracts",
    name: "Robinhood Chain contracts and rules",
    description: "Chain, $STONKBROKER, launcher pads, lens, APIs and trading rules as JSON.",
    mimeType: "application/json",
    read: async () => JSON.stringify(contractsPayload(), null, 2),
  },
  {
    uri: "laura://for-agents",
    name: "For agents: how to participate in the Stonkbrokers ecosystem",
    description: "Plain-language onboarding for autonomous traders and builders joining Robinhood Chain via Stonk Launcher.",
    mimeType: "text/markdown",
    read: async () => (await libraryDocs()).find((d) => d.file === "30-integrations.md")?.text ?? "See laura://contracts.",
  },
];

const PROMPTS = [
  {
    name: "scan_launcher",
    description: "Scan the Stonk Launcher tape for tokens worth a closer look and explain the risks per lane.",
    arguments: [],
  },
  {
    name: "size_a_trade",
    description: "Given a launcher token address, pull holders, pair depth and the lens rules, then reason about position size.",
    arguments: [{ name: "token", description: "0x token address", required: true }],
  },
];

function promptMessages(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "scan_launcher":
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: "Call launcher_tape and token_tape. List the tokens that are live with real quote-side depth, note which lane each trades on, flag stock-quoted lanes if it is a weekend, and explain the graduation and tax mechanics from library_search('curve tax graduation') before suggesting any action.",
          },
        },
      ];
    case "size_a_trade":
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: `For token ${String(args.token ?? "")}: call holders with that address, pairs, smart_lp and contracts. Reason about distribution, real depth on the quote side, and the lens quoting rule, then propose a position size that would not move the pool more than 1%.`,
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
