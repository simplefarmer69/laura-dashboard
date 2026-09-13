# Anvil and LAURA's own contracts on Robinhood Chain

LAURA writes, compiles, deploys and verifies smart contracts (operator directive
2026-09-13). Two kinds exist, and every agent should know the difference.

## Anvil designs (agent `smith`)

Anvil reads the WATCHED VOICES (Elon, Trump, Vitalik, Vlad), the LAUNCH
REQUESTS from mentions, the X pulse and the community chat, and about every
six hours may design ONE small standalone contract that gives people something
they are asking for: a guestbook, a poll, an RSVP or pledge registry, a name
registry, a commit-reveal game with no money, a time capsule, a who-was-first
counter. Rules the code enforces before the compiler even runs: one file, one
contract, pragma 0.8.28, no `payable`, no `msg.value`, no external calls, no
`owner`/`admin`, no assembly, no `selfdestruct`/`delegatecall`, bounded
strings, events on every action, source under 7,000 chars. A compile error is
handed back to Anvil up to twice with the exact message.

Deploys run inside FORGE_CAPS (2 per day, 8 per week, 3h apart, 3M gas and
0.003 ETH per deploy, never under the 0.35 ETH treasury floor), then the source
is submitted to Blockscout and Sourcify. Only when a verifier accepts it does
Anvil draft the X post, which always carries the explorer link (Read and Write
tabs work for anyone without a frontend). Events: `forge.proposed`,
`forge.deployed`, `forge.verified`, `forge.failed`. Ledger: `forgeProjects` in
state, `/api/forge`, the `forge_projects` MCP tool.

## Flagship deployments (vendored, audited, operator-reviewed)

Contracts that move value or call other contracts never come from a prompt.
They live in `src/lib/forge/contracts/`, ship with a foundry test suite and an
audit note in `audits/`, and seed themselves once as approved projects through
the same executor and caps, skipping only the prompt-output gate.

### Ownership Market (`OwnershipMarket`) — our first useful contract, not our last

A marketplace for **ownership of smart contracts**. Any contract with
`owner()` and `transferOwnership(address)` (Ownable, Ownable2Step, NFT
collections, tokens, vaults, games) can be listed for sale in the native coin
or any ERC-20, with a 280-byte description of what it does.

Flow: seller `createListing(target, payToken, price, description)` while still
the owner → seller `transferOwnership(market)` on their contract (escrow;
Ownable2Step targets: anyone `acceptEscrow(id)`) → buyer `buy(id, token,
price)` → **anyone** `deliver(id)` (ownership to the buyer, 1% fee booked) →
seller `claimProceeds(id)`. Buyer `refund(id)` if nobody delivered within 1
day; seller `cancel(id)` gets escrowed ownership back; `withdrawFees(token)`
pushes the 1% to LAURA's treasury and anyone can call it. No owner, no admin,
no pause, no upgrade; the fee recipient is immutable.

Talking points (all true, all checkable):
- 1% protocol fee on every sale goes to LAURA's treasury: protocol revenue for
  the mission, from builders across the whole chain, not only StonkBrokers.
- 20 foundry tests: reentrancy, fee-on-transfer and USDT-style tokens,
  front-running of escrowed contracts, refunds, Ownable2Step, no privileged
  role. Audit note: `audits/ownership-market/AUDIT.md`.
- Guide for humans (every call, viem and cast examples):
  https://github.com/simplefarmer69/laura-dashboard/blob/main/docs/OWNERSHIP-MARKET.md
- **Anyone can host a frontend for it.** Say so every time. The contract is
  the product; a static page with viem and four buttons is a complete
  marketplace UI. Teams that build one get linked by the swarm.
- Order matters for sellers: list first, then transfer. Ownership sent to the
  market without a listing cannot be returned.
- Who it is for: NFT teams handing a collection to new stewards, builders
  selling finished tools, DAOs buying the vault they already use, anyone
  leaving a project who would rather sell than abandon.

The deployed address and explorer link are in the ON-CHAIN STATE block
(LAURA'S OWN CONTRACTS) once live; cite them exactly. Until `forge.verified`
fires, talk about it as "shipping", never as live.

How each agent uses it: Quill and Sage explain it plainly with both links;
Nudge and Relay find teams on X with a collection, token or tool they might
sell and point them to it; Ticker watches for the first `Listed` event;
Scout counts listings and fees as protocol revenue; Anvil studies it as the
worked example of a contract the swarm stands behind and proposes the next
flagship when a real need appears (the operator reviews flagship source in the
repo before it seeds).
