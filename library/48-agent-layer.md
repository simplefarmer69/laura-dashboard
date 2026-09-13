# The agent layer: MCP server, manifest, and how other agents join

LAURA is not the only agent that should trade Robinhood Chain. Every autonomous
trader, research assistant, or agent framework that can read the launcher tape and
quote the pads is a candidate participant, and every trade on a launcher lane is
protocol revenue for $STONKBROKER holders. The agent layer is the plumbing that makes
joining a one-URL affair. It is public, read only, and keyless.

## Surfaces (real, live, quote them by URL)

- MCP server: `https://laura.stonkbrokers.io/api/mcp` (Streamable HTTP, stateless
  JSON-RPC 2.0, protocol 2025-06-18). Tools: `launcher_tape`, `token_tape`, `pairs`,
  `holders(token?)`, `smart_lp`, `brokertools`, `fee_breakdown`, `contracts`,
  `library_search(query)`, `library_doc(file)`, `laura_state`. Resources:
  `laura://contracts`, `laura://for-agents`. Prompts: `scan_launcher`,
  `size_a_trade(token)`.
- Agent manifest: `https://laura.stonkbrokers.io/api/agents/manifest` (chain, RPC,
  $STONKBROKER, pads by lane, lens, factory, launcher APIs, feed URLs, MCP endpoint,
  rules).
- Onboarding page for agents and their operators: `https://laura.stonkbrokers.io/for-agents.md`.
- Raw feeds: `https://laura.stonkbrokers.io/api/feeds/<name>`.
- Same endpoints exist on the operator daemon at `http://127.0.0.1:4747/`.

## What the layer will never do

No tool signs, spends, launches, posts, or edits LAURA's state. Agents bring their own
wallets. Nothing in the layer carries a secret; every tool proxies data that is
already public on the console. Do not describe it as a trading API; it is a data and
context surface with the exact addresses attached.

## Who uses it inside the swarm

- Relay (ambassador) pitches it to agent framework teams, bot operators and MCP client
  maintainers, one counterparty class per cycle, rotating.
- Broker (bd) files it with MCP registries, agent directories and data aggregators using
  the manifest fields verbatim.
- Catalyst (growth) may post about it on X when there is a real number to lead with
  (a new integration, a first agent trade routed through a lane).
- Scholar (researcher) watches for agent frameworks and registries worth listing in.

Log every listing or registry submission in the notebook under
`Agentic traders: <surface>` so the next cycle does not repeat it and Ledger can count.

## Truth rules for talking about it

- Only the tools listed above exist. Never invent a write tool.
- Adoption numbers come from `brokertools`, `pairs` and the notebook; never estimate.
- The pitch is real markets and real data, never volume for its own sake.
