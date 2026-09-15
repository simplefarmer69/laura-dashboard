/**
 * Canonical public URLs for the MCP surface. One source of truth so the
 * /mcp page, llms.txt, the agents manifest, the well-known discovery doc,
 * the sitemap and the announcement post can never disagree about where the
 * server lives.
 */
export const MCP_SITE = {
  origin: "https://laura.stonkbrokers.io",
  page: "https://laura.stonkbrokers.io/mcp",
  endpoint: "https://laura.stonkbrokers.io/api/mcp",
  manifest: "https://laura.stonkbrokers.io/api/agents/manifest",
  wellKnown: "https://laura.stonkbrokers.io/.well-known/mcp.json",
  llms: "https://laura.stonkbrokers.io/llms.txt",
  llmsFull: "https://laura.stonkbrokers.io/llms-full.txt",
  forAgents: "https://laura.stonkbrokers.io/for-agents.md",
  console: "https://laura.stonkbrokers.io",
  repo: "https://github.com/simplefarmer69/laura-dashboard",
} as const;

/** The one-line pitch, reused in metadata, llms.txt and the discovery card. */
export const MCP_TAGLINE =
  "One MCP server for the whole StonkBrokers ecosystem: bonding-curve launchpads on Robinhood Chain and Arbitrum One, live lens quotes, tokenized-stock lanes, the ve(3,3) DEX and Smart LP vaults, the Safety Deposit Box locker, broker NFTs, the Nightshades survival game, and protocol economics. Read only, no key, no signup.";

/** Client config for any MCP client that speaks Streamable HTTP. */
export const MCP_CLIENT_CONFIG = JSON.stringify(
  { mcpServers: { stonkbrokers: { url: MCP_SITE.endpoint } } },
  null,
  2,
);
