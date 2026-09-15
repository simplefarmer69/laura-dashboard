# StonkBrokers ecosystem MCP server

LAURA operates a read-only [Model Context Protocol](https://modelcontextprotocol.io)
server covering the **whole StonkBrokers ecosystem** so other agents (trading
bots, research assistants, agent frameworks) can read and price it through one
standard interface. The purpose is ecosystem growth: every agent that can see
the tape, quote the pads and know the rules is a candidate participant, and
every trade on a launcher lane is protocol revenue for $STONKBROKER holders.

Public docs page: **https://laura.stonkbrokers.io/mcp**

## Endpoint

- Public viewer: `POST https://laura.stonkbrokers.io/api/mcp`
- Operator daemon: `POST http://127.0.0.1:4747/api/mcp`

Transport: Streamable HTTP, **stateless**. One JSON-RPC 2.0 message (or a
batch) per POST, one JSON response. No session id, no SSE stream (`GET`
returns a JSON discovery card instead). CORS is open. Protocol version
`2025-06-18`. No authentication.

Client config:

```json
{ "mcpServers": { "stonkbrokers": { "url": "https://laura.stonkbrokers.io/api/mcp" } } }
```

```bash
claude mcp add --transport http stonkbrokers https://laura.stonkbrokers.io/api/mcp
```

```bash
curl -s https://laura.stonkbrokers.io/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s https://laura.stonkbrokers.io/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"quote_launch","arguments":{"lane":"weth","launchId":"276","side":"buy","amountIn":"0.05"}}}'
```

## Tools

Connecting clients are told to call `ecosystem_map` first.

### Orientation

| name | arguments | source |
| --- | --- | --- |
| `ecosystem_map` | none | static, from `lib/mcp/ecosystem.ts` (library 25 + verified addresses) |
| `contracts` | none | static from `lib/launchpad/contracts.ts`, both chains |
| `laura_state` | none | `/api/state` summary (mission, latest metrics, roster, deployed launches) |

### Trade a curve

| name | arguments | source |
| --- | --- | --- |
| `quote_launch` | `lane`, `launchId`, `side`, `amountIn`, `seller?` | live `SafeLaunchLensV2.quoteBuy` / `quoteSell` on the lane's own chain |
| `token_detail` | `token` | both chains' grid APIs, resolved to one row |
| `launcher_tape` | none | `/api/feeds/launcher` |
| `arbitrum_launcher` | none | 21 Arbitrum pads + the Arbitrum grid tape |
| `holders` | `token?` | `/api/feeds/holders` |

### Market depth

| name | arguments | source |
| --- | --- | --- |
| `token_tape` | none | `/api/feeds/tokens` |
| `pairs` | none | `/api/feeds/pairs` |
| `smart_lp` | none | `/api/feeds/smartlp` |

### Protocol economics

| name | arguments | source |
| --- | --- | --- |
| `protocol_economics` | none | `/api/feeds/defillama` |
| `fee_breakdown` | none | `/api/feeds/fee-breakdown` |
| `chain_compare` | none | `/api/feeds/llama-chains` |
| `brokertools` | none | `/api/feeds/brokertools` |

### Games and collectibles

| name | arguments | source |
| --- | --- | --- |
| `nightshades` | none | on-chain game state via `lib/launchpad/nightshades.ts` + static reference |
| `nft_market` | none | `/api/feeds/nft-trends` + `/api/feeds/nft-buys` |
| `prediction_markets` | none | `/api/feeds/polymarket` |

### LAURA's own work

| name | arguments | source |
| --- | --- | --- |
| `laura_contracts` | none | `/api/forge` (the Ownership Market and Anvil's utilities, with ABI and how-to-use) |
| `library_search` | `query`, `limit?` | `/library` (repo docs plus the data-dir overlay) |
| `library_doc` | `file` | one library doc, full text |

Tool results carry both `content[0].text` (JSON string) and
`structuredContent` (the object).

Resources: `stonkbrokers://ecosystem`, `laura://contracts`,
`laura://nightshades` (all JSON), `laura://for-agents` (markdown).
Prompts: `onboard_agent`, `scan_launcher`, `size_a_trade(token)`,
`find_agent_edge`.

## Boundaries

- Read only. There is no tool that signs, spends, launches, posts, or edits
  state. Agents bring their own wallets.
- No secrets. Every tool proxies data already public on the console. The
  handlers call the feed route functions in-process (no network hop, no
  origin guessing), so the server behaves identically on the viewer and on
  the daemon.
- Body limit 64 KiB; unknown methods return `-32601`; notifications
  (`notifications/initialized` and friends) return `202` with no body.

## Discovery and SEO surfaces

Agents find this server without being told to, which is the point:

- `GET /mcp`: the human docs page, with JSON-LD (`WebAPI` +
  `SoftwareApplication` + `FAQPage`) so search and agent directories can
  index the endpoint, the tool list and the price (free).
- `GET /.well-known/mcp.json`: discovery card at the conventional path for
  MCP registries.
- `GET /llms.txt`: the short agent-facing index of the whole site.
- `GET /llms-full.txt`: every tool description, resource, prompt, ecosystem
  entry, address and gotcha in one plain-text fetch — enough to integrate
  without loading a page or connecting a client.
- `GET /robots.txt`: names and allows the AI crawlers explicitly (several
  ignore a bare wildcard when deciding retrieval permission), keeps the
  operator-only API out of indexes, and advertises the entry points above.
- `GET /sitemap.xml`: `/mcp` first.
- `GET /api/agents/manifest`: machine-readable onboarding card (chain, RPC,
  contracts, feeds, MCP endpoint and client config, rules).
- `GET /for-agents.md`: plain-language onboarding for agents and operators.
- `library/skills/agentic-traders.md`: how Relay, Broker and Catalyst point
  agent builders at these surfaces.

## Files

- `src/lib/mcp/server.ts`: JSON-RPC dispatcher, tool/resource/prompt registry,
  grouped catalogue for the docs.
- `src/lib/mcp/ecosystem.ts`: the ecosystem map, the lens quote, token lookup,
  the Arbitrum pad table and the Nightshades reference.
- `src/lib/mcp/site.ts`: canonical public URLs, reused by every surface.
- `src/app/api/mcp/route.ts`: HTTP transport (GET card, POST handler, CORS).
- `src/app/mcp/page.tsx`: the public docs page and its structured data.
- `src/app/llms.txt`, `src/app/llms-full.txt`, `src/app/robots.txt`,
  `src/app/sitemap.ts`, `src/app/.well-known/mcp.json`: discovery surfaces.
- `src/app/api/agents/manifest/route.ts`: manifest.
