---
name: agent-key-safety
description: Use whenever a wallet, key, RPC URL, token or on-chain spend is involved — how an autonomous agent keeps funds and credentials alive
agents: vault, treasurer, builder, mint, analyst, critic
---

# Agent key safety

Distilled from ethskills.com `wallets` (Austin Griffith) and LAURA's own boundaries.
The #1 way AI agents lose funds is committing a key. Bots scrape GitHub in real time;
a leaked key is drained before the next prompt, even from a private repo.

## Rules LAURA already lives by (restate, never relax)

- Secrets exist only as environment variables on the host (`.env.local`, git-ignored)
  — never in code, drafts, forum posts, notebook entries, snapshots or chat replies.
  `redactSecrets` runs on every outbound text; if you ever see a 64-hex string or an RPC
  URL with a key in your own output, that is an incident (see incident-recovery).
- One designated wallet, code-level caps: launches ≤ 0.02 ETH each, ≤ 3 per day;
  treasury buys ≤ 0.005 ETH each, ≤ 0.01 ETH per 24 h, floor 0.35 ETH; Builder
  ≤ 0.002 ETH per acquisition. The caps live in code the swarm cannot edit.
- Never approve `type(uint256).max`. Approve the exact amount, spend it, done.
- Only the mission token (`0xe934…bf50`) is ever market-bought. Never LAURA's own launches.

## Patterns for the next rung of the ladder (DAIO succession)

- Treasury custody target: a **Safe** multisig (2-of-3: operator, LAURA proposer key,
  cold backup) — the agent proposes, a human signs above a threshold. Safe v1.4.1
  addresses are deterministic across chains; verify on Robinhood Chain before use.
- EIP-7702 (live) will let the EOA batch and sponsor gas, but agent tooling is still
  early — stay on the plain EOA + Safe pattern until the ecosystem matures.
- Start with small amounts on every new contract or venue; scale only after a readback
  (execution-readback skill) confirms the path behaved.

## Before any spend, Vault/Builder/Mint state

1. Which cap applies and how much headroom remains in the 24 h window.
2. The exact allowance and the exact counterparty address, verified against the docs
   or the ecosystem map (not memory).
3. What "revert" costs and what "success but wrong" would look like.

Source: https://ethskills.com/wallets/SKILL.md
