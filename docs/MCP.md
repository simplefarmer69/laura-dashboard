# LAURA MCP server

LAURA exposes a read-only [Model Context Protocol](https://modelcontextprotocol.io)
server so other agents (trading bots, research assistants, agent frameworks)
can read Robinhood Chain and the Stonk Launcher through one standard
interface. The purpose is ecosystem growth: every agent that can see the
tape, quote the pads and know the rules is a candidate participant, and
every trade on a launcher lane is protocol revenue for $STONKBROKER holders.

## Endpoint

- Public viewer: `POST https://laura.stonkbrokers.io/api/mcp`
- Operator daemon: `POST http://127.0.0.1:4747/api/mcp`

Transport: Streamable HTTP, **stateless**. One JSON-RPC 2.0 message (or a
batch) per POST, one JSON response. No session id, no SSE stream (`GET`
returns a JSON discovery card instead). CORS is open. Protocol version
`2025-06-18`.

Client config examples:

```json
{ "mcpServers": { "laura": { "url": "https://laura.stonkbrokers.io/api/mcp" } } }
```

```bash
curl -s https://laura.stonkbrokers.io/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s https://laura.stonkbrokers.io/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"holders","arguments":{"token":"0x04921d4c9fc16fe86b995a54696104a128c51387"}}}'
```

## Tools

| name | arguments | source |
| --- | --- | --- |
| `launcher_tape` | none | `/api/feeds/launcher` |
| `token_tape` | none | `/api/feeds/tokens` |
| `pairs` | none | `/api/feeds/pairs` |
| `holders` | `token?` (0x address) | `/api/feeds/holders` |
| `smart_lp` | none | `/api/feeds/smartlp` |
| `brokertools` | none | `/api/feeds/brokertools` |
| `fee_breakdown` | none | `/api/feeds/fee-breakdown` |
| `chain_compare` | none | `/api/feeds/llama-chains` (Robinhood Chain vs all chains, StonkBrokers rank on the chain) |
| `contracts` | none | static from `src/lib/launchpad/contracts.ts` |
| `laura_contracts` | none | `/api/forge` (contracts LAURA deployed herself: the Ownership Market and Anvil's utilities, with ABI, address, explorer link and how-to-use) |
| `library_search` | `query`, `limit?` | `/library` (repo docs plus the data-dir overlay) |
| `library_doc` | `file` | one library doc, full text |
| `laura_state` | none | `/api/state` summary (mission, latest metrics, roster, deployed launches) |

Tool results carry both `content[0].text` (JSON string) and
`structuredContent` (the object).

Resources: `laura://contracts` (JSON), `laura://for-agents` (markdown).
Prompts: `scan_launcher`, `size_a_trade(token)`.

## Boundaries

- Read only. There is no tool that signs, spends, launches, posts, or edits
  state. Agents bring their own wallets.
- No secrets. Every tool proxies data already public on the console. The
  handlers call the feed route functions in-process (no network hop, no
  origin guessing), so the server behaves identically on the viewer and on
  the daemon.
- Body limit 64 KiB; unknown methods return `-32601`; notifications
  (`notifications/initialized` and friends) return `202` with no body.

## Companion surfaces

- `GET /api/agents/manifest`: machine-readable onboarding card (chain, RPC,
  contracts, feeds, MCP endpoint, rules).
- `GET /for-agents.md`: plain-language onboarding for agents and their
  operators.
- `library/skills/agentic-traders.md`: how Relay, Broker and Catalyst point
  agent builders at these surfaces.

## Files

- `src/lib/mcp/server.ts`: JSON-RPC dispatcher, tool and resource registry.
- `src/app/api/mcp/route.ts`: HTTP transport (GET card, POST handler, CORS).
- `src/app/api/agents/manifest/route.ts`: manifest.
