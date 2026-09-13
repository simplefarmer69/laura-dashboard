# The Lab: buy and sell smart contracts on Robinhood Chain

**Live:** https://laura.stonkbrokers.io/lab

The Lab is LAURA's frontend for the [Ownership Market](./OWNERSHIP-MARKET.md),
the contract that lets anyone sell **ownership of a smart contract** (an NFT
collection, a token, a vault, a game, a tool: anything with `owner()` and
`transferOwnership(address)`) to anyone else, in any token, with the ownership
escrowed by the market and the payment released only after delivery. 1%
protocol fee, no owner, no admin, no pause, no upgrade path.

The Lab adds the storefront: image, longer description, website, GitHub, X,
Telegram, Discord and audit links per listing. That data lives **on-chain**
in the Lab registry, written only by the listing's seller, so every frontend
renders the same storefront and nobody has to trust LAURA's server for it.

| | address (Robinhood Chain, id 4663) |
| --- | --- |
| OwnershipMarket | [`0x184aceB1FFE04701d6fdF75f7AdC638651578923`](https://robinhoodchain.blockscout.com/address/0x184aceB1FFE04701d6fdF75f7AdC638651578923?tab=contract) |
| LabRegistry | deployed by the swarm right after the market; the live address shows on the Lab page and in [`/api/forge`](https://laura.stonkbrokers.io/api/forge) (flagship key `lab-registry`) |

Source: [`src/lib/forge/contracts/`](../src/lib/forge/contracts). Tests and
audit notes: [`audits/ownership-market`](../audits/ownership-market/AUDIT.md),
[`audits/lab-registry`](../audits/lab-registry/AUDIT.md). Frontend:
[`src/components/lab`](../src/components/lab) and [`src/lib/lab`](../src/lib/lab).

## Selling from the Lab

Connect the wallet that is the current `owner()` of your contract, open
**Sell a contract**, and follow the five steps. The page re-reads the chain
after every transaction, so it never claims an escrow it cannot see.

1. **Check the contract.** Paste the address. The Lab checks that it has
   code, that `owner()` responds and is your wallet, that there is no live
   listing for it, whether its source is verified on Blockscout (verify it
   first: buyers will not pay for code they cannot read) and whether it is
   `Ownable2Step` (has `pendingOwner()`).
2. **Terms.** Payment token (ETH, WETH, USDG, STONKBROKER or any ERC-20
   address), price, and the 280-byte on-chain description. You receive 99%.
3. **`createListing`.** One transaction. **Order matters:** the listing is
   created while you are still the owner. Ownership sent to the market without
   a listing cannot be attributed to anyone and cannot be returned.
4. **Escrow the ownership.** `transferOwnership(market)` on *your* contract,
   from the page. For `Ownable2Step` contracts this only names the market as
   pending owner; the page then offers **Accept escrow** (`acceptEscrow(id)`,
   anyone may call it), after which the market checks that it really is
   `owner()`. Buyers cannot pay before that: `buy()` reverts `NotEscrowed`.
5. **Storefront (optional).** Name, long description, image URL (`https` or
   `ipfs`), website, GitHub, docs, X handle, Telegram, Discord, tags and up to
   six audit links. Saved as one JSON record (3000 bytes max) with
   `setMetadata(id, json)` on the registry. Only you can write it; you can
   edit or clear it later from the listing.

After the sale, open the listing under **My activity** and **Claim proceeds**.
If the buyer refunded because nobody delivered, **Close and take ownership
back** (`cancel`) returns the escrowed ownership to you.

## Buying from the Lab

Open a listing. The **trust check** panel is read live from the chain:

- the target is a contract, and its source is verified on Blockscout (red
  when it is not: do not buy code you cannot read);
- `owner()` responds and is the market right now (otherwise buying is disabled
  and the contract itself would refuse with `NotEscrowed`);
- whether it is `Ownable2Step` (you will finish with `acceptOwnership()`);
- a reminder that you are buying whatever the owner role controls in *that*
  contract (mint, fees, pause, upgrade, funds), which only its source can tell.

Tick the acknowledgement, approve the token if the listing is not in ETH, and
**Buy**. The Lab passes the exact terms you saw to `buy(id, expectedPayToken,
expectedPrice)`, so a price edit in flight makes the transaction revert
instead of overcharging you. Then anyone (you, the seller, a bot) clicks
**Deliver**; the market moves ownership to you and only then books the 1% fee.
`Ownable2Step` targets: the listing then shows **Accept ownership**; nobody can
take the contract in between because the market stays `owner()` until you
accept and never re-lists. If nobody delivers within 24 hours, **Refund**
returns your payment in full.

## The Ownable2Step question, answered

> A seller who lists an Ownable2Step contract hands the market a pending
> slot, not ownership. Does the market check `owner()` equals itself, or does
> it trust the call returned?

It checks, at every step that matters:

- `buy()` reads `owner()` **live** and reverts `NotEscrowed` unless the
  market is the owner. A pending-only listing cannot be bought; no funds move,
  no fee is booked (`test_ownable2StepPendingOnlyCannotBeSold_noFeeOnNothing`).
- `acceptEscrow()` calls `acceptOwnership()` and then requires `owner() ==
  market`, reverting otherwise.
- `deliver()` calls `transferOwnership(buyer)` and then requires `owner() ==
  buyer` **or** `pendingOwner() == buyer`; anything else reverts
  `DeliveryFailed`, which also unwinds the fee booking. The buyer can refund
  after 24h (`test_deliveryFailsWhenTargetDoesNotHandOver`).
- Between delivery and the buyer's `acceptOwnership()`, the market is still
  `owner()`, so nobody can `createListing` for it (that requires being the
  owner) and the seller cannot `cancel` (the listing is `Delivered`)
  (`test_ownable2StepDeliveredCannotBeRelistedBeforeAccept`).

What the market cannot check is *semantics*: a target whose `owner()` lies or
that keeps a second admin path is still that contract after purchase. That is
why the Lab puts the explorer's verified-source check first and in red when it
fails, and why every post about the market says "read the source".

## Calling the registry from code

```ts
import { createPublicClient, http, parseAbi } from "viem";

const registryAbi = parseAbi([
  "function getMetadata(uint256 id) view returns (string metadata, address setBy, uint64 updatedAt)",
  "function getMetadataBatch(uint256 fromId, uint256 toId) view returns ((string metadata, address setBy, uint64 updatedAt)[])",
  "function setMetadata(uint256 id, string metadata)",
  "function clearMetadata(uint256 id)",
]);

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const [json] = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getMetadata", args: [1n] });
```

Record shape (all fields optional, links `https://`, `http://` or `ipfs://`):

```json
{
  "name": "Tip Jar v2",
  "description": "What the contract does, what the owner controls, why you are selling.",
  "image": "ipfs://…",
  "website": "https://…",
  "github": "https://github.com/…",
  "docs": "https://…",
  "x": "@handle",
  "telegram": "https://t.me/…",
  "discord": "https://discord.gg/…",
  "audits": [{ "title": "Auditor, 2026-09", "url": "https://…" }],
  "tags": ["nft", "game"]
}
```

Treat every field as untrusted seller input: text is text, links are links,
nothing executes. The zod schema the Lab uses is
[`src/lib/lab/metadata.ts`](../src/lib/lab/metadata.ts).

## Host your own Lab (please do)

The page is a static client: it reads the market and the registry through the
public RPC (and multicall3 at the canonical address), asks Blockscout whether
a target's source is verified, and sends transactions from the user's own
wallet. It talks to no server of LAURA's except to discover the registry
address once, and you can pin that in `src/lib/lab/contracts.ts` instead.

Copy `src/components/lab`, `src/lib/lab` and the few `src/components/ui`
primitives they use into any Next.js or Vite project, keep or change the RPC,
and deploy it anywhere. The market does not care which frontend a transaction
came from, and the swarm links to frontends people build: tag
[@LAURA_DAIO](https://x.com/LAURA_DAIO) on X.
