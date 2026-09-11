# ethskills.com and the Austin Griffith agent stack — external knowledge rail

Operator directive (2026-09-11): use Austin Griffith's ethskills and related repos
for more skills and context. This file indexes what exists, what LAURA absorbed,
and what is executable.

## What ethskills is

`https://ethskills.com` (repo `austintgriffith/ethskills`, 282 stars, active Aug 2026)
is "the missing knowledge between AI agents and production Ethereum": one markdown
skill per topic, written for agents, correcting stale training data (gas is ~0.05 gwei
not 30; EIP-7702 is live; ERC-8004 and x402 exist; Uniswap V4 hooks are live).
Every page is fetchable at `https://ethskills.com/<skill>/SKILL.md`; the host is on
LAURA's browse allowlist, so any agent can `readNext` a page and have it next cycle.

| page | when LAURA needs it |
|---|---|
| `ship` | before any Builder utility: architecture, contract count, CROPS gate, archetypes |
| `security`, `testing` | Builder pre-deploy, Critic review of a build |
| `concepts` | "nothing is automatic" incentive design; randomness; teaching in context |
| `standards` | ERC-8004 agent identity, x402, EIP-3009, EIP-7702 status and addresses |
| `wallets` | key safety, Safe pattern for the treasury ladder |
| `building-blocks` | Uniswap V4 hooks (STORMM context), Aero, Arbitrum stack, composability guardrails |
| `indexing` | events as the read API; never loop blocks — relevant to the on-chain read layer |
| `protocol` | what actually shipped vs roadmap; forkcast.org before fork claims |
| `why`, `gas`, `l2s` | numbers for writers: costs, upgrades, the agent angle. **`l2s` gained a Robinhood Chain section on 2026-08-20** (settles directly to Ethereum with blob DA, stock tokens are Jersey-issued debt securities not available to US persons, shared admin registry with no timelock, ArbOS 61 tx filtering defeats force inclusion, USDG is 6 decimals) — distilled into `ethereum-literacy` and `onchain-engineering` on 2026-09-11 |
| `addresses` | verified (cast-checked Aug 20, 2026) Robinhood Chain addresses: NVDA/TSLA/AAPL/MSFT/AMZN/GOOGL/META/COIN/SPCX/SPY/QQQ stock tokens, USDG, WETH, `AccessControlsRegistry`, plus the mainnet bridge and rollup core — the only place to copy an address from besides Blockscout |
| `crops` | architecture review lens (censorship resistance, open/free, privacy, security) |
| `frontend-ux`, `frontend-playbook`, `orchestration` | not LAURA's job (viewer is read-only) |

Distilled into LAURA's skills: `onchain-engineering` (builder, critic, vault, mint),
`ethereum-literacy` (writers, researchers), `agent-key-safety` (spenders).

## Related repos worth a Scholar read

- `austintgriffith/evm-audit-skills` — 20 checklist skills, 500+ non-obvious findings
  (precision math, ERC-20 quirks, AMM/V4 attacks, oracles, DoS, access control,
  **chain-specific: Arbitrum/Orbit quirks that apply to Robinhood Chain**). Critic's
  red-team of any Builder utility should pull the matching checklist:
  `https://raw.githubusercontent.com/austintgriffith/evm-audit-skills/main/<skill>/references/checklist.md`.
- `austintgriffith/ethskills-evals` — how to measure whether an agent actually learned
  from a skill doc; a model for grading LAURA's own skill uptake.
- `scaffold-eth/scaffold-eth-2` (via `clawd-builder`, `greeting-demo`) — the SE2
  three-phase build system agents use to ship dApps; reference if Builder ever grows a
  frontend for a utility.
- `austintgriffith/liquidity-vesting`, `interfold`, `picowallet` — adjacent ideas
  (vesting locks, confidential coordination, hardware stablecoin wallet); context only.

## Ideas this unlocks (gated like everything else)

1. **LAURA as an ERC-8004 agent.** Register an onchain identity (IdentityRegistry
   `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, ReputationRegistry
   `0x8004BAa1…9b63`, deterministic on 20+ chains) with an `agentURI` pointing at
   `laura.stonkbrokers.io/.well-known/agent-registration.json`. Fits the charter
   ("identify as AI") and gives the viewer a verifiable identity. Requires: confirm the
   registry exists on Robinhood Chain (or register on Base and reference it),
   operator go-ahead, spend inside Builder caps. Not a token play; a trust play.
2. **x402 on LAURA's feeds.** `/api/feeds/*` are free and stay free; an `upto`-priced
   premium feed (e.g. per-launch analytics) is a revenue experiment for Ledger/Analyst
   to price, not to ship unasked.
3. **Fork tests for Builder.** Stand up a Robinhood Chain fork in the Builder's test
   step so templates are tested against the live launcher and locker addresses.
4. **Terminology.** "onchain" in LAURA's voice; the site's own copy is quoted as-is.

## Interpretation rules

- ethskills is mainnet/L2-general; Robinhood Chain specifics (chain id 4663, pad
  addresses, lanes, lockers) come from the official site surface and `20-project.md`,
  which win on conflict.
- Verify addresses before use; ethskills' addresses are for the chains it names.
