---
name: onchain-engineering
description: Use when designing, reviewing or shipping any contract or onchain utility — architecture discipline, the non-obvious vulnerability classes, Robinhood Chain (Arbitrum Orbit) quirks and the pre-deploy gate
agents: builder, critic, vault, mint
---

# Onchain engineering

Distilled from ethskills.com (Austin Griffith, `ship`, `security`, `testing`, `concepts`
skills) and the `evm-audit-skills` checklists, adapted to Robinhood Chain. Fetch the
source pages with `readNext` when you need the full code patterns:
`https://ethskills.com/ship/SKILL.md`, `/security/SKILL.md`, `/testing/SKILL.md`,
`/concepts/SKILL.md`, `/standards/SKILL.md`.

## Architecture before code

- Most utilities need 0–2 contracts. Three is the ceiling for an MVP. If the design
  needs more, the design is wrong, not the budget.
- Solidity is for ownership, transfers and commitments. Not a database, not an API.
  Anything that does not move trust stays offchain (LAURA's own runtime, the feeds).
- Nothing is automatic. Every state transition needs a caller who pays gas and a
  reason to call. For each transition, name the caller, the incentive and what happens
  if nobody calls. "The team will trigger it" is a centralization finding, not a plan.
- CROPS gate (EF values): who can censor or freeze users (`Pausable` + `onlyOwner` is a
  censorship vector — flag it), is the whole stack forkable, what becomes public, who
  controls funds/upgrades/exit. Label options by CROPS impact; do not present neutral
  tradeoff lists.
- No proxies for utilities. Immutable, small, verified. Proxies buy upgrade paths at
  the cost of trust assumptions LAURA's charter does not want to ask holders for.

## Vulnerability classes that pass "it works"

- Decimals vary (USDC/USDG-style stables are 6, most stock tokens 18). Normalize before
  cross-token math; multiply before dividing; round in the protocol's favour.
- Reentrancy: Checks → Effects → Interactions, plus a guard on anything that sends ETH
  or calls a token. ERC-721/1155 callbacks and ERC-777 hooks are reentrancy points.
- Weird ERC-20s: fee-on-transfer (measure balance before/after), rebasing, pausable,
  blocklisted, missing return values (use SafeERC20), approve races. Never
  `type(uint256).max` approvals on LAURA's wallet.
- Oracles: never a DEX spot price. TWAP has limits too; a thin Robinhood Chain pool can be
  moved for cents. If a value gates money, it needs a manipulation-cost argument.
- Vault share inflation (ERC-4626 first-depositor attack): virtual offset or seed
  deposit. Applies to any "pool shares" utility.
- Access control: two-step ownership transfer, no single key over user funds, timelocks
  where a param changes economics. Input validation on every external entry point.
- DoS: unbounded loops over user-supplied arrays, force-sent ETH breaking accounting,
  revert-griefing in push payments (use pull).
- Randomness: `blockhash`/`prevrandao` are gameable; use commit-reveal or a VRF. The
  launcher's own VRNG buyback shows how the ecosystem does it — match it, do not improvise.
- Signatures (EIP-712): domain separator, nonce, deadline. Replay across chains is a
  real vector because Robinhood Chain shares tooling with every other Orbit chain.

## Robinhood Chain is Arbitrum Orbit — chain quirks

- `block.number` is the approximate **L1** block number and moves in jumps (~1 min);
  many L2 txs share one value. Use `block.timestamp` for time and
  `ArbSys(0x64).arbBlockNumber()` if you truly need an L2 block. LAURA's templates use
  `block.timestamp` for this reason; keep it that way.
- `block.basefee` reports L1 base fee; gas math must use the `ArbGasInfo` precompile.
- Sequencer downtime freezes execution: anything time- or price-sensitive must tolerate
  a gap (stale price checks, grace periods).
- Retryable tickets and L1→L2 messages: out of LAURA's scope — never build them.
- Chain id 4663, gas token ETH, explorer robinhoodchain.blockscout.com. Verify stock
  token addresses against Robinhood's asset registry, never by symbol.
- Stock tokens (ethskills `l2s`/`addresses`, verified Aug 20, 2026): 18 decimals, one
  Chainlink feed each, blocklist-gated, and every one is pausable, blockable, mintable,
  confiscatable (`adminBurn`) and upgradeable through a shared `AccessControlsRegistry`
  (`0xe10b6f6B275de231345c20D14Ab812db62151b00`) **with no timelock**. A stock-lane
  launch's quote asset can therefore be paused by the issuer; design and disclose for
  that (a paused quote means a frozen curve, not a rug by LAURA).
- Splits and dividends adjust `uiMultiplier()` (draft ERC-8056 "Scaled UI Amount");
  raw balances never rebase. Index and compare raw amounts, render with the multiplier.
- **USDG is 6 decimals** (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`); WETH is
  `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. Any usdg-lane math that assumes 18
  decimals is off by 1e12.
- Censorship model: ArbOS 61 tx filtering can reject any tx hash, including L1
  force-included ones; Stage 0 on L2Beat, two whitelisted validators, no exit window.
  Anything censorship-sensitive fails the CROPS gate on this chain by construction.

## Testing that finds real bugs

- Do not test getters or OpenZeppelin internals. Test state transitions with adversarial
  ordering and values (fuzz), and test integrations on a **fork** of Robinhood Chain,
  not against mocks of the launcher, Uniswap or the lockers.
- Every finding in the review uses the standard format: severity, location, scenario,
  impact, fix. "Looks fine" is not a review output.

## Pre-deploy gate (Builder must produce this list; Critic must check it)

1. Contract count ≤ 2 and each state transition has a named caller + incentive.
2. CROPS labels written down; no hidden admin freeze.
3. Decimals, CEI, SafeERC20, access control, DoS and oracle items above ticked.
4. Fork test passed against live Robinhood Chain addresses; constructor args in the log.
5. Spend inside the Builder caps (0.002 ETH per acquisition, 0.004 ETH per 24 h) and
   `autoExecuteUtility` still governs execution — the gate never widens itself.
6. Verified source on Blockscout within the same cycle; artifact recorded in the Runs.
