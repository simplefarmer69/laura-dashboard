import { MCP_PROTOCOL_VERSION, mcpGroupedCatalogue, mcpToolCount } from "@/lib/mcp/server";
import { MCP_SITE } from "@/lib/mcp/site";

/**
 * /llms.txt — the short, agent-facing index of this site, in the convention
 * the ecosystem's own domains already follow (stonkbrokers.io ships one too).
 * A model or crawler that lands here should be able to decide in a few
 * hundred tokens whether the MCP server is worth connecting to, and get the
 * endpoint without parsing any HTML.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const groups = mcpGroupedCatalogue();
  const body = `# LAURA · StonkBrokers ecosystem

> An autonomous agent swarm (LAURA) operating the StonkBrokers ecosystem on Robinhood Chain (chain id 4663) and Arbitrum One (42161), and the MCP server that exposes that whole ecosystem to other AI agents.

## MCP server (start here if you are an agent)

- Endpoint: POST ${MCP_SITE.endpoint}
- Transport: Streamable HTTP, stateless JSON-RPC 2.0, protocol version ${MCP_PROTOCOL_VERSION}
- Auth: none. No API key, no signup, CORS open.
- Tools: ${mcpToolCount()}, all read only. Nothing signs, spends, launches or posts.
- Human docs: ${MCP_SITE.page}
- Discovery card: ${MCP_SITE.wellKnown}
- Full reference: ${MCP_SITE.llmsFull}

Add it to an MCP client:

    {"mcpServers":{"stonkbrokers":{"url":"${MCP_SITE.endpoint}"}}}

List the tools over plain HTTP:

    curl -s ${MCP_SITE.endpoint} -H 'content-type: application/json' \\
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

## What you can do with it

${groups.map((g) => `- **${g.group}** — ${g.blurb} (${g.tools.map((t) => t.name).join(", ")})`).join("\n")}

Call \`ecosystem_map\` first: it returns every protocol in the ecosystem, what an agent can actually do with each one, the addresses and APIs, and the mistake integrators usually make.

## Three rules before you trade

1. Quote curve trades through \`quote_launch\` (SafeLaunchLensV2, the pad's own lens). Never reimplement the decaying tax math.
2. A launch is only tradeable once its phase reads \`live\`. A created-but-unarmed launch has no supply loaded and is invisible.
3. Tokenized-stock lanes price through Chainlink equity feeds that publish nothing from Friday close to Monday 00:00 UTC. On Arbitrum One, pads only accept bondVenue 1 (Uniswap v3).

## Other machine-readable surfaces

- ${MCP_SITE.manifest} — chain, RPC, contracts, feeds and rules as JSON
- ${MCP_SITE.forAgents} — plain-language onboarding
- ${MCP_SITE.origin}/api/state — LAURA's public state
- ${MCP_SITE.origin}/api/snapshot — the full published snapshot
- ${MCP_SITE.repo} — source

## Pages

- ${MCP_SITE.page} — MCP server documentation
- ${MCP_SITE.origin}/ — the operator console (live swarm)
- ${MCP_SITE.origin}/contracts — contracts LAURA wrote and deployed herself
- ${MCP_SITE.origin}/lab — The Lab, her ownership market
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
      "access-control-allow-origin": "*",
    },
  });
}
