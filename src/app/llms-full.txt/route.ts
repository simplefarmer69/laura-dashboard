import { ecosystemMap } from "@/lib/mcp/ecosystem";
import {
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  mcpGroupedCatalogue,
  mcpPromptCatalogue,
  mcpResourceCatalogue,
  mcpToolCount,
} from "@/lib/mcp/server";
import { MCP_SITE } from "@/lib/mcp/site";
import { DEFAULT_AGENTS } from "@/lib/swarm/roster";

/**
 * /llms-full.txt — the long form: every tool with its full description, every
 * resource and prompt, and the complete ecosystem map with addresses and
 * gotchas. One fetch, no HTML, enough for an agent to integrate without ever
 * loading a page or connecting a client.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const eco = ecosystemMap();
  const groups = mcpGroupedCatalogue();
  const resources = mcpResourceCatalogue();
  const prompts = mcpPromptCatalogue();

  const toolSection = groups
    .map(
      (g) =>
        `### ${g.group}\n${g.blurb}\n\n${g.tools
          .map((t) => `#### ${t.name}\n${t.description}`)
          .join("\n\n")}`,
    )
    .join("\n\n");

  const ecoSection = eco.entries
    .map((e) => {
      const lines = [
        `### ${e.name} (${e.category})`,
        e.what,
        `**For an agent:** ${e.agentOpportunity}`,
      ];
      if (e.contracts && Object.keys(e.contracts).length > 0) {
        lines.push(`**Addresses:**\n${Object.entries(e.contracts).map(([k, v]) => `- ${k}: \`${v}\``).join("\n")}`);
      }
      if (e.urls.length > 0) lines.push(`**Links:** ${e.urls.join(" · ")}`);
      if (e.gotcha) lines.push(`**Watch out:** ${e.gotcha}`);
      lines.push(`**Tools:** ${e.tools.join(", ")}`);
      return lines.join("\n\n");
    })
    .join("\n\n");

  const body = `# StonkBrokers ecosystem MCP server — full reference

Generated ${eco.generatedAt}. Server ${MCP_SERVER_NAME} v${MCP_SERVER_VERSION}, MCP protocol ${MCP_PROTOCOL_VERSION}.

- Endpoint: POST ${MCP_SITE.endpoint}
- Human docs: ${MCP_SITE.page}
- Discovery: ${MCP_SITE.wellKnown}
- Transport: Streamable HTTP, stateless. One JSON-RPC 2.0 message (or batch) per POST, one JSON response. No session id, no SSE. GET returns a discovery card. CORS open. Body limit 64 KiB.
- Auth: none.
- Tool count: ${mcpToolCount()}, all read only.

## Server instructions (what the server tells a connecting client)

${MCP_INSTRUCTIONS}

## Ecosystem

${eco.summary}

${ecoSection}

## Tools

${toolSection}

## Resources

${resources.map((r) => `- \`${r.uri}\` (${r.mimeType}) — ${r.name}: ${r.description}`).join("\n")}

## Prompts

${prompts.map((p) => `- \`${p.name}\` — ${p.description}`).join("\n")}

## Calling convention

Every tool result carries both \`content[0].text\` (the JSON as a string) and \`structuredContent\` (the object). Unknown methods return -32601. Notifications return HTTP 202 with no body.

Example — list tools:

    curl -s ${MCP_SITE.endpoint} -H 'content-type: application/json' \\
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

Example — quote a buy on a live curve:

    curl -s ${MCP_SITE.endpoint} -H 'content-type: application/json' \\
      -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"quote_launch","arguments":{"lane":"weth","launchId":"276","side":"buy","amountIn":"0.05"}}}'

Example — resolve a token address:

    curl -s ${MCP_SITE.endpoint} -H 'content-type: application/json' \\
      -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"token_detail","arguments":{"token":"0xb571bD61b64b2658d806D4b894d8164B7E53F178"}}}'

## Boundaries

- Read only. No tool signs, spends, launches, posts or edits state. Agents bring their own wallet.
- No secrets. Every tool proxies data already public on the console and on chain.
- Quote through the lens. The curve tax decays minute by minute; reimplementing it is the most common integration bug.

## Operator

LAURA, an autonomous agent swarm of ${DEFAULT_AGENTS.length} agents growing the StonkBrokers ecosystem toward a $1B $STONKBROKER market cap. Console: ${MCP_SITE.console}. Source: ${MCP_SITE.repo}.
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
      "access-control-allow-origin": "*",
    },
  });
}
