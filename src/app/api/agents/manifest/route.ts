import { NextResponse, type NextRequest } from "next/server";
import { LAUNCHPAD, PAD_LANE_KEYS, ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { DEFAULT_SETTINGS } from "@/lib/swarm/roster";
import { MCP_PROTOCOL_VERSION, mcpToolCatalogue } from "@/lib/mcp/server";

/**
 * Machine-readable onboarding card for autonomous agents: one GET that tells
 * a trading bot or agent framework everything it needs to start participating
 * in the Stonkbrokers ecosystem on Robinhood Chain - chain, RPC, contracts,
 * public data feeds, the MCP endpoint, and the rules. Public, read only, no
 * secrets; the same facts the console renders for humans.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const feeds = ["launcher", "tokens", "pairs", "holders", "smartlp", "brokertools", "fee-breakdown", "defillama", "nft-buys", "nft-trends"];
  return NextResponse.json(
    {
      schema: "laura.agents.manifest/1",
      generatedAt: new Date().toISOString(),
      operator: { project: "Stonkbrokers", agent: "LAURA", console: "https://laura.stonkbrokers.io", x: "https://x.com/LAURA_DAIO" },
      chain: {
        id: ROBINHOOD_CHAIN.id,
        name: ROBINHOOD_CHAIN.name,
        rpc: "https://rpc.mainnet.chain.robinhood.com",
        explorer: ROBINHOOD_CHAIN.blockExplorers.default.url,
        nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
      },
      tokens: {
        stonkbroker: DEFAULT_SETTINGS.tokenAddress,
      },
      launcher: {
        name: "Stonk Launcher (StonkSafeLaunchpadV2)",
        ui: "https://www.stonkbrokers.cash/launcher",
        docs: "https://www.stonkbrokers.cash/docs",
        pads: LAUNCHPAD.pads,
        lanes: PAD_LANE_KEYS,
        lens: LAUNCHPAD.lens,
        factory: LAUNCHPAD.factory,
        gridApi: LAUNCHPAD.gridApi,
        floorApi: LAUNCHPAD.floorApi,
      },
      feeds: Object.fromEntries(feeds.map((f) => [f, `${origin}/api/feeds/${f}`])),
      mcp: {
        endpoint: `${origin}/api/mcp`,
        transport: "streamable-http",
        protocolVersion: MCP_PROTOCOL_VERSION,
        tools: mcpToolCatalogue().map((t) => t.name),
      },
      humanDocs: `${origin}/for-agents.md`,
      rules: [
        "Read only surface: nothing here signs, spends, launches or posts on your behalf.",
        "Quote launcher trades through SafeLaunchLensV2; never reimplement curve math.",
        "Stock-quoted lanes (gme, nvda, aapl, spcx, uso) are dark from Friday close to Monday 00:00 UTC.",
        "A launch is visible to users only once the floor API reports phase 'live'.",
        "Every lane's protocol revenue accrues to $STONKBROKER holders.",
      ],
    },
    { headers: { "access-control-allow-origin": "*", "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" } },
  );
}
