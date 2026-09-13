# Ownership Market: buy and sell smart contracts on Robinhood Chain

`OwnershipMarket` is a contract written, audited, deployed and verified by
LAURA (the StonkBrokers agent swarm). It lets anyone sell the **ownership** of a
smart contract they control to anyone else, in the native coin or any ERC-20,
with the ownership held in escrow by the market until the buyer has paid.

If your contract has `owner()` and `transferOwnership(address)` (OpenZeppelin
`Ownable`, `Ownable2Step`, most NFT collections, tokens, vaults, games), it can
be listed. An NFT project handing its collection to a new team, a builder
selling a finished tool, a DAO buying a vault it has been using: same three
calls each way.

- Source: [`src/lib/forge/contracts/OwnershipMarket.sol`](../src/lib/forge/contracts/OwnershipMarket.sol)
- Tests and audit note: [`audits/ownership-market/`](../audits/ownership-market/)
- Deployed address and explorer link: posted by LAURA on X and listed on the
  [live dashboard](https://laura.stonkbrokers.io) under Contracts once the
  explorer has verified the source. The address is also in the `forge.deployed`
  and `forge.verified` events of the swarm.
- Chain: Robinhood Chain, chain id 4663, explorer `https://robinhoodchain.blockscout.com`
- Compiler: solc 0.8.28, optimizer 200 runs, EVM `paris`. Verified source,
  so every function below is on the explorer's **Read Contract** and
  **Write Contract** tabs and works with any wallet.

**There is no frontend from us, on purpose.** The contract is the product.
Anyone can host a frontend for it (see the last section); the swarm will
happily point people at yours.

## The flow in one picture

```
SELLER                          MARKET (escrow)                    BUYER
  |-- createListing(...) ----------->|   listing #id, status Listed
  |-- transferOwnership(market) ---->|   (call this on YOUR contract)
  |                                  |<---------------- buy(id, token, price) --|
  |                                  |   status Sold, funds held
  |   anyone ------- deliver(id) --->|   ownership -> buyer, 1% fee booked
  |<-- claimProceeds(id) ------------|   seller receives price - 1%
  |                                  |
  |   anyone --- withdrawFees(t) --->|   fees -> LAURA treasury
```

## Selling a contract

**Step 1. Create the listing while you are still the owner.**

```
createListing(address target, address payToken, uint256 price, string description) -> uint256 id
```

- `target`: the contract you are selling. The market checks that
  `target.owner() == msg.sender`, so only the current owner can list it.
- `payToken`: `0x0000000000000000000000000000000000000000` for the native
  coin, otherwise the ERC-20 address the buyer must pay in (USDG, WETH,
  $STONKBROKER, any token).
- `price`: in the token's smallest unit (wei for the native coin; for a
  6-decimal stablecoin, 250 USD is `250000000`).
- `description`: up to 280 bytes. Say what the contract does and what the
  buyer gets (`"ERC-721 collection, 4,444 minted, 5% royalties to owner, metadata frozen"`).

The call emits `Listed(id, target, seller, payToken, price, description)`.
Note the `id`; every later call uses it.

**Step 2. Move ownership into escrow.** On **your** contract, call
`transferOwnership(<market address>)`. From now on the market is the owner. If
your contract is `Ownable2Step`, this only sets the pending owner: anyone then
calls `acceptEscrow(id)` on the market and it accepts.

Your listing is now live: `isEscrowed(id)` returns `true` and a buyer can pay.
Until step 2 is done a `buy` reverts with `NotEscrowed`.

**Order matters.** Create the listing first, then transfer. Ownership sent to
the market with no live listing cannot be attributed to anyone and cannot be
returned, because the market only trusts `owner()` at the moment of listing.

**Changing your mind.** `updateListing(id, payToken, price, description)` edits
an unsold listing. `cancel(id)` closes it and, if the market holds the
ownership, hands it straight back to you.

## Buying a contract

Read the target's **verified source** first. The market guarantees the
`owner()` / `transferOwnership()` mechanics and nothing about what the contract
does; a contract with a hidden second admin or a backdoor is still that
contract after you own it.

```
buy(uint256 id, address expectedPayToken, uint256 expectedPrice)   payable
```

- Native listing: send exactly `price` as the transaction value.
- ERC-20 listing: first `approve(<market>, price)` on the token, then call
  `buy` with value `0`.
- `expectedPayToken` / `expectedPrice` must match the listing. If the seller
  edited the listing in the same block, your call reverts with
  `ListingChanged` instead of paying a different price.

The market takes the payment into escrow and marks the listing `Sold`.

## Delivery: anyone can execute it

```
deliver(uint256 id)
```

Anyone may call this on a `Sold` listing: the buyer, the seller, a bot, a
stranger. The market calls `transferOwnership(buyer)` on the target, checks
that the buyer is now the owner (or the pending owner for `Ownable2Step`),
books the 1% fee and marks the listing `Delivered`. If the target refuses to
hand over, the call reverts with `DeliveryFailed` and nothing changes.

## Getting paid

```
claimProceeds(uint256 id)      seller only, after delivery
```

Pays the seller `price - 1%` in the listing's token. Pull-based on purpose: a
seller address that cannot receive the token cannot block delivery.

## Protection when things stall

- **Buyer:** if nobody has delivered within **1 day** of the sale (the target
  refuses the handover, say), `refund(id)` returns the full payment. No fee is
  taken on a refund.
- **Seller:** after a refund the listing is `Refunded`; `cancel(id)` hands the
  escrowed ownership back to you.
- **Anyone:** `expire(id)` closes a listing whose target is owned by neither
  the seller nor the market (the seller transferred it elsewhere), so the
  target can be listed again by its real owner.

## Fees

- `FEE_BPS = 100`: 1% of what the market actually received, booked at
  delivery. `quote(paid)` returns `(fee, proceeds)`.
- Fees accrue per token in `accruedFees(token)`. `withdrawFees(token)` pushes
  them to `feeRecipient`, LAURA's treasury wallet; anyone may call it, nobody
  can redirect it. `feeRecipient` is `immutable`, set once at deploy.
- The market has **no owner, no admin, no pause and no upgrade path**. What is
  verified on the explorer is what runs, forever.

## Reading state

| call | returns |
| --- | --- |
| `listingCount()` | total listings ever created; ids run 1..N |
| `getListing(id)` | `target, seller, buyer, payToken, price, paid, createdAt, soldAt, status, proceedsClaimed, description` |
| `activeListingOf(target)` | live listing id for a contract (0 = none) |
| `isEscrowed(id)` | whether the market currently owns the target |
| `accruedFees(token)` | protocol fees waiting to be pushed |
| `quote(amount)` | `(fee, proceeds)` for a sale at `amount` |

`status` values: `0 None, 1 Listed, 2 Sold, 3 Delivered, 4 Cancelled, 5 Refunded`.

Events for indexers: `Listed`, `ListingUpdated`, `Escrowed`, `Cancelled`,
`Sold`, `Delivered`, `ProceedsClaimed`, `Refunded`, `FeesWithdrawn`.

## Calling it from code

viem, native-coin listing, seller side:

```ts
import { createWalletClient, http, parseEther } from "viem";
const market = "0x<market address>";
const id = await wallet.writeContract({
  address: market, abi, functionName: "createListing",
  args: [myContract, "0x0000000000000000000000000000000000000000", parseEther("2"), "a finished tip-jar contract, 300 users"],
});
await wallet.writeContract({ address: myContract, abi: ownableAbi, functionName: "transferOwnership", args: [market] });
```

Buyer side, then anyone delivers:

```ts
await wallet.writeContract({ address: market, abi, functionName: "buy", args: [1n, zeroAddress, parseEther("2")], value: parseEther("2") });
await wallet.writeContract({ address: market, abi, functionName: "deliver", args: [1n] });
```

`cast` from foundry works too:

```
cast send $MARKET "createListing(address,address,uint256,string)" $TARGET 0x0000000000000000000000000000000000000000 2000000000000000000 "what it does" --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $PK
cast send $TARGET "transferOwnership(address)" $MARKET --rpc-url ... --private-key $PK
cast call $MARKET "isEscrowed(uint256)(bool)" 1 --rpc-url ...
```

The ABI is on the explorer's Code tab (verified) and in
[`src/lib/forge/contracts/OwnershipMarket.sol`](../src/lib/forge/contracts/OwnershipMarket.sol).

## Host a frontend for it (please do)

The contract does not need us. A frontend is: read `listingCount()`, loop
`getListing(i)` (or index the `Listed` / `Sold` / `Delivered` events), show
the target's verified source and the description, and wire four buttons to
`createListing`, `buy`, `deliver` and `claimProceeds`. A static page with
viem or ethers and a wallet connector is enough; no backend, no keys, nothing
to trust. Add the `transferOwnership(market)` step for sellers with a check on
`isEscrowed(id)` and a warning that the listing must exist first.

If you host one, tag [@LAURA_DAIO](https://x.com/LAURA_DAIO) on X. The swarm
links to frontends people build; that is how this becomes a marketplace rather
than a contract.

## Audit summary

The test suite (`forge test` from the repo root, 20 tests) covers: the full
native and ERC-20 flows, 1% fee accounting, fee-on-transfer tokens (fee taken
on what arrived), USDT-style tokens without a return value, tokens returning
`false`, listing validation, the front-running case (ownership sitting at the
market with no listing cannot be claimed by anyone), price edits vs. a buyer
quoting old terms, cancel before and after escrow, stale-listing expiry,
refund after the delay and the seller reclaiming ownership, no refund after
delivery and no double claim, `Ownable2Step` end to end, a target that refuses
to hand over (delivery reverts, buyer refunded), reentrancy from a malicious
target, a seller that rejects native payouts (fees still flow), and the
absence of any owner/admin function on the market. The full note is in
[`audits/ownership-market/AUDIT.md`](../audits/ownership-market/AUDIT.md).

Known limits, stated plainly: the market verifies the *interface* of the
target, not its intent (buyers must read the source); a target with a
`pendingOwner` step needs the buyer to call `acceptOwnership()` themselves
after delivery; ownership sent to the market before a listing exists is lost.
