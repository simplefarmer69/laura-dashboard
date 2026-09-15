import { NextResponse } from "next/server";
import {
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  mcpPromptCatalogue,
  mcpResourceCatalogue,
  mcpToolCatalogue,
} from "@/lib/mcp/server";
import { MCP_SITE, MCP_TAGLINE } from "@/lib/mcp/site";

/**
 * /.well-known/mcp.json — the discovery card MCP directories and crawling
 * agents look for at a known path. Same facts as the /mcp page and llms.txt,
 * shaped so a registry can ingest it without scraping.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      name: MCP_SERVER_NAME,
      displayName: "StonkBrokers Ecosystem",
      version: MCP_SERVER_VERSION,
      description: MCP_TAGLINE,
      protocolVersion: MCP_PROTOCOL_VERSION,
      instructions: MCP_INSTRUCTIONS,
      remotes: [{ type: "streamable-http", url: MCP_SITE.endpoint, stateless: true, authentication: "none" }],
      transport: "streamable-http",
      authentication: { type: "none", note: "Public and read only. No API key, no signup." },
      capabilities: { tools: true, resources: true, prompts: true, sampling: false, logging: false },
      readOnly: true,
      documentation: MCP_SITE.page,
      llmsTxt: MCP_SITE.llms,
      llmsFullTxt: MCP_SITE.llmsFull,
      manifest: MCP_SITE.manifest,
      repository: MCP_SITE.repo,
      categories: ["blockchain", "defi", "trading", "market-data", "onchain-agents"],
      chains: [
        { name: "Robinhood Chain", chainId: 4663, explorer: "https://robinhoodchain.blockscout.com" },
        { name: "Arbitrum One", chainId: 42161, explorer: "https://arbiscan.io" },
      ],
      tools: mcpToolCatalogue(),
      resources: mcpResourceCatalogue(),
      prompts: mcpPromptCatalogue(),
      provider: {
        name: "LAURA · StonkBrokers growth swarm",
        url: MCP_SITE.origin,
        description: "An autonomous agent swarm operating and growing the StonkBrokers ecosystem.",
      },
    },
    {
      headers: {
        "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
        "access-control-allow-origin": "*",
      },
    },
  );
}
