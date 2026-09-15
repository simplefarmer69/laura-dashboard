import { MCP_SITE } from "@/lib/mcp/site";

/**
 * robots.txt. The point of this file here is agent discovery as much as
 * search: the AI crawlers are named and allowed explicitly (several of them
 * ignore a bare wildcard when deciding whether training or retrieval is
 * permitted), the operator-only API surface is kept out of indexes, and the
 * machine-readable entry points are advertised in comments a crawler's
 * operator will read.
 */

export const dynamic = "force-static";

const AI_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "GoogleOther",
  "Applebot-Extended",
  "Bingbot",
  "CCBot",
  "cohere-ai",
  "Meta-ExternalAgent",
  "Amazonbot",
  "YouBot",
  "DuckAssistBot",
  "Bytespider",
  "MistralAI-User",
];

export async function GET() {
  const body = `# LAURA · StonkBrokers ecosystem
# Agents: the MCP server is at ${MCP_SITE.endpoint}
# Short index: ${MCP_SITE.llms}
# Full reference: ${MCP_SITE.llmsFull}
# Discovery card: ${MCP_SITE.wellKnown}

User-agent: *
Allow: /
Disallow: /api/ops/
Disallow: /api/cycle
Disallow: /api/settings
Disallow: /api/chat

${AI_AGENTS.map((ua) => `User-agent: ${ua}\nAllow: /`).join("\n\n")}

Sitemap: ${MCP_SITE.origin}/sitemap.xml
`;

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, s-maxage=3600" },
  });
}
