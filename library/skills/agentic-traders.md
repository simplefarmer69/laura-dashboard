---
name: agentic-traders
description: Use when the goal is to bring another autonomous agent, trading bot, or agent framework onto Robinhood Chain and the Stonk Launcher, or when writing anything addressed to agent builders
agents: ambassador, bd, growth, researcher
---

# Agentic traders (bringing other agents into the ecosystem)

Every autonomous trader that can read the tape and quote the pads is a candidate
participant, and every trade on a launcher lane is protocol revenue for $STONKBROKER
holders. Our job is to make the path from "found LAURA" to "first read, first quote,
first swap" as short as possible for a machine.

## The surfaces we offer (say them by URL, they are real)

- MCP server, read only, no key: `https://laura.stonkbrokers.io/api/mcp` (Streamable
  HTTP, stateless). Tools: `launcher_tape`, `token_tape`, `pairs`, `holders`,
  `smart_lp`, `brokertools`, `fee_breakdown`, `contracts`, `library_search`,
  `library_doc`, `laura_state`.
- Manifest, one JSON card: `https://laura.stonkbrokers.io/api/agents/manifest`.
- Plain onboarding page: `https://laura.stonkbrokers.io/for-agents.md`.
- Raw feeds: `https://laura.stonkbrokers.io/api/feeds/<launcher|tokens|pairs|holders|smartlp|brokertools>`.
- Docs for the pad contract: `https://www.stonkbrokers.cash/docs` (Trading App Integration).

## Who to talk to

1. Builders of agent frameworks and trading bots (open-source repos, MCP registries,
   agent marketplaces). The pitch: one MCP URL gives their agents a whole chain's
   launcher tape with vetted depth and exact contracts.
2. Operators of existing on-chain agents on other chains. The pitch: Robinhood Chain is
   an Arbitrum-stack L2 with tokenized-stock lanes nobody else has; the lens contract
   makes quoting safe.
3. Data and research agents. The pitch: `library_search` is a curated, operator-edited
   knowledge base on a live ecosystem, free.

## How to write it

- Lead with the URL and one thing the agent can do in its first call.
- Give the chain id (4663), the RPC, and the lens address in the body; machines and
  their operators copy from the message, not from a link.
- Say the boundary plainly: read only, bring your own wallet, no returns promised.
- Never claim volume or adoption numbers that `brokertools` or `pairs` do not show.
- For a registry or directory listing, use the manifest fields verbatim.

## What to log

Every listing filed, registry submitted, or builder replied to goes in the notebook
under `Agentic traders: <surface>` with the URL and the date, so the next cycle does
not file it twice and Ledger can count it.
