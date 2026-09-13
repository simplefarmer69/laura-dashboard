# LabRegistry audit note

- Contract: `src/lib/forge/contracts/LabRegistry.sol` (single file, no imports)
- Compiler: solc 0.8.28, optimizer 200 runs, EVM `paris` (same pipeline as the Ownership Market: `scripts/solc-compile.mjs` produces the deployed bytecode and the verification input)
- Tests: `test/LabRegistry.t.sol`, run with `forge test -vv` from the repo root (foundry >= 1.0, no external libraries). 12 tests, all passing at the time of the review, alongside the 22 Ownership Market tests in the same run.
- Depends on: the deployed `OwnershipMarket` (constructor argument, `immutable`). The registry only ever calls `getListing(id)` on it, a view.

## What it is

The storefront layer for Ownership Market listings. The market stores 280 bytes of description per listing and nothing else; buyers want an image, a longer description, a website, GitHub, socials and audit links. The registry stores one JSON string per listing id (3000 bytes max) so that every frontend (LAURA's The Lab and anyone else's) renders the same storefront from chain data, with no server of LAURA's in the path.

## Threat model

Actors: the seller of a listing, anyone else (impersonator, buyer, third party), frontends that render the records. The registry holds **no value** and has **no privileged role**; the only asset is the integrity of the attribution (a record on listing `id` was written by its seller) and the availability of the records.

## Design decisions and why

1. **Seller-only writes, checked live.** `setMetadata` and `clearMetadata` read `market.getListing(id).seller` on every call and revert `NotSeller` for anyone else, `NoListing` for unknown ids. Nobody can plant a storefront on someone else's listing, and a buyer cannot rewrite the record of a listing they bought (tested: buyer after delivery is refused). The seller keeps write access for the life of the listing id, including after the sale, because the record is theirs; frontends show `setBy` and `updatedAt` so a post-sale edit is visible.
2. **Bounded storage.** `MAX_METADATA_BYTES = 3000` (tested at the boundary and one over). Batch reads take an explicit range and tolerate an inverted range; no unbounded loops over user-controlled data.
3. **Untrusted content by construction.** The contract does not parse or validate the JSON; that is a frontend concern and stated in the NatSpec. The Lab frontend parses with a strict zod schema, renders text as text, only follows `http(s)`/`ipfs` links, never executes anything from a record, and degrades a malformed record to "on-chain data only".
4. **No privileged role, no value.** No owner, no setter, no pause, no upgrade, no `selfdestruct`, no `delegatecall`, no payable function. The market address is `immutable` and rejected if zero (tested). The worst a hostile record can do is be ugly.
5. **Separate from the market on purpose.** Storefront data changes more often than sale terms and must never gate a sale; keeping it out of the market means the audited market surface stays exactly as deployed, and metadata gas is paid only by sellers who want it.

## Findings

No critical, high or medium findings.

- **Low (accepted, documented):** the seller can change the record after the sale (see decision 1). Frontends display `updatedAt`; the on-chain description in the market itself is frozen once sold (`updateListing` requires `Listed`).
- **Info:** records are plain seller claims. An "audits" entry is a link the seller typed, not a verification. The Lab labels the section "audits (seller supplied)" and puts the explorer's verified-source check above it.
- **Info:** `getMetadataBatch` over a very large id range can exceed RPC response limits; frontends page it (The Lab reads `1..listingCount` which is small; it can chunk when the market grows).

## Test map

| test | property |
| --- | --- |
| `test_constructorRejectsZeroMarket` | immutable market is non-zero |
| `test_sellerSetsAndReadsMetadata` | write, event, `setBy`, `updatedAt` |
| `test_sellerReplacesMetadata` | overwrite |
| `test_strangerCannotSet` | `NotSeller` |
| `test_buyerCannotSetEvenAfterDelivery` | buyer of a delivered listing is still not the seller |
| `test_unknownListingReverts` | `NoListing` |
| `test_tooLongReverts` / `test_maxLengthAccepted` | 3000-byte boundary |
| `test_sellerClears` / `test_strangerCannotClear` | delete path and its guard |
| `test_batchRead` | range read, empty slots, inverted range |
| `test_metadataSurvivesSaleAndOnlySellerKeepsWriting` | attribution across the sale |

## Deployment

Seeded by `src/lib/forge/flagship.ts` (key `lab-registry`) once the Ownership Market is live, with the market's address as the constructor argument; deployed and verified by the same executor and caps as every other LAURA contract. The Lab frontend discovers the registry address from `/api/forge` once the project is `deployed`/`verified`, so no frontend redeploy is needed.
