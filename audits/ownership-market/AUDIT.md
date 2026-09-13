# OwnershipMarket audit note

- Contract: `src/lib/forge/contracts/OwnershipMarket.sol` (single file, no imports, 8,557 bytes of creation code)
- Compiler: solc 0.8.28, optimizer 200 runs, EVM `paris` (matches `scripts/solc-compile.mjs`, which produces the deployed bytecode and the verification input)
- Tests: `test/OwnershipMarket.t.sol`, run with `forge test -vv` from the repo root (foundry >= 1.0, no external libraries). 20 tests, all passing at the time of the review.
- Reviewed against: the ethskills security checklist distilled in `library/skills/onchain-engineering.md` (reentrancy, CEI, unchecked returns, pull vs push payments, privileged roles, fee-on-transfer and non-standard ERC-20s, griefing, front-running).
- Local end-to-end: deployed with the repo's own solc-js artifact to a local `anvil` node and driven through list, escrow, buy, deliver, claim and fee withdrawal with viem (deploy gas 1,883,368; seller net 0.99 of a 1 ETH sale; 0.01 ETH to the fee recipient).

## Threat model

Actors: seller, buyer, third-party executor of `deliver`, the target contract (possibly malicious), the payment token (possibly non-standard), the fee recipient (passive). The market holds two kinds of value: escrowed **ownership** (it is the `owner()` of listed targets) and escrowed **payments** between `buy` and `claimProceeds`/`refund`.

Goals: a seller can never lose ownership without being paid; a buyer can never lose payment without receiving ownership (or a refund); nobody but the parties can move either; the market itself has no privileged role.

## Design decisions and why

1. **List first, then transfer.** `createListing` requires `target.owner() == msg.sender`. Ownership sitting at the market with no listing cannot be claimed by anyone (tested). The alternative (list after transferring) lets an attacker front-run the listing of a contract whose ownership is already at the market and sell it to themselves. The cost is a documented footgun: ownership sent before listing is unrecoverable, because the market cannot attribute it. The explainer and the seed event say so in capitals.
2. **Anyone may deliver.** `deliver` is permissionless (operator requirement). It is safe because state is closed (`Delivered`, fee booked) before the external `transferOwnership`, the call is `nonReentrant`, and success is checked afterwards (`owner() == buyer` or `pendingOwner() == buyer` for `Ownable2Step`).
3. **Pull payments.** Seller proceeds and protocol fees are pulled (`claimProceeds`, `withdrawFees`), so a seller or recipient that cannot receive the token cannot block delivery or anyone else's flow (tested with a rejecting native receiver).
4. **Fee on what arrived.** `buy` measures the market's balance delta, so fee-on-transfer tokens are charged on the real amount and the seller is paid from real funds (tested at 10%).
5. **Non-standard tokens.** `_safeCall` accepts an empty return (USDT-style) and rejects `false`; both tested.
6. **Buyer-side term lock.** `buy(id, expectedPayToken, expectedPrice)` reverts with `ListingChanged` if the seller edited the listing in the same block, so a native buyer never overpays and an ERC-20 buyer's allowance is never pulled at a different price.
7. **Time-boxed escrow of payment.** If delivery cannot happen (target refuses), the buyer refunds in full after `REFUND_DELAY` (1 day); no fee on refunds. The seller then `cancel`s to get the escrowed ownership back. Tested end to end, including a target that hands over once and then ignores transfers.
8. **No privileged role.** No `owner()`, no setter for the fee recipient, no pause, no upgrade, no `selfdestruct`, no `delegatecall`. `feeRecipient` is `immutable` and rejected if zero. Tested by probing the deployed market for `owner()`, `transferOwnership(address)` and `setFeeRecipient(address)`.
9. **Reentrancy.** Single `nonReentrant` guard on every function that makes an external call (`acceptEscrow`, `cancel`, `expire`, `buy`, `deliver`, `claimProceeds`, `refund`, `withdrawFees`); views are excluded. A target that re-enters `deliver` from `transferOwnership` reverts with `Reentrancy()` (tested). CEI is followed everywhere (status flips before external calls).
10. **Bounded storage.** Descriptions are capped at 280 bytes; no unbounded loops; one live listing per target via `activeListingOf`.

## Findings

No critical or high findings. Items accepted with documentation:

- **Medium (accepted, documented):** the market verifies the *interface* of the target, not its semantics. A target whose `owner()` lies or that keeps a second admin path is still that contract after purchase. Mitigation is the explorer's verified source and the explainer's "read the source first"; a marketplace cannot fix contract intent.
- **Low (accepted, documented):** ownership transferred to the market without a live listing is unrecoverable (see decision 1). Frontends should sequence the two calls and check `activeListingOf(target)` before offering the transfer button.
- **Low (accepted):** `Ownable2Step` buyers must call `acceptOwnership()` on the target themselves after delivery; the market cannot do it for them. Delivery marks success when `pendingOwner() == buyer`.
- **Info:** `expire` lets anyone close a listing whose target is owned by neither the seller nor the market. It only frees `activeListingOf`; it cannot move ownership or funds.
- **Info:** payment tokens with blocklists (some stablecoins) can freeze the market's balance for that token; this affects only listings in that token and is inherent to those tokens.

## Test map

| test | property |
| --- | --- |
| `test_constructorRejectsZeroFeeRecipient` | immutable recipient is non-zero |
| `test_feeIsOnePercent` | `FEE_BPS == 100`, `quote` math |
| `test_happyPathNative` | list, escrow, buy, anyone delivers, claim, fee withdraw; balances to the wei |
| `test_happyPathERC20` | same in a 6-decimal ERC-20 |
| `test_feeOnTransferTokenUsesReceivedAmount` | fee on real receipts |
| `test_silentTokenAccepted_falseTokenRejected` | USDT-style accepted, `false` rejected |
| `test_listRequiresCurrentOwner_noFrontRunOfEscrowedContracts` | front-running defence |
| `test_listValidation` | zero price, non-contract target/token, 281-byte description, duplicate listing |
| `test_buyRequiresEscrowAndExactTerms` | `NotEscrowed`, `WrongValue`, `ListingChanged`, no double buy |
| `test_cancelReturnsOwnership` / `test_cancelBeforeEscrowIsFine` | seller exit paths |
| `test_expireStaleListing` | permissionless cleanup, relist by the real owner |
| `test_refundAfterDelayThenSellerReclaims` | buyer protection, no fee, seller recovery |
| `test_noRefundAfterDelivery_noDoubleClaim` | finality |
| `test_ownable2StepFlow` | two-step targets end to end |
| `test_deliveryFailsWhenTargetDoesNotHandOver` | `DeliveryFailed`, then refund |
| `test_reentrancyFromTargetIsBlocked` | guard on `deliver` |
| `test_nativePayoutToRejectingSellerReverts` | pull payments isolate failures |
| `test_withdrawFeesRequiresBalance` | no zero pushes |
| `test_marketHasNoOwner` | no privileged surface |

## Deployment

The executor (`src/lib/forge/executor.ts`) deploys the vendored source through the same path as Anvil's designs but without the prompt-output gate (`kind: "flagship"`), inside `FORGE_CAPS` (gas and cost ceilings, treasury floor, deploy pacing), submits the source to Blockscout and Sourcify, and only announces on X once a verifier accepts it. Constructor argument: the swarm wallet address as `feeRecipient`.
