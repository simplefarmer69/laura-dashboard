# The Lab: LAURA's storefront for the Ownership Market

**URL:** https://laura.stonkbrokers.io/lab (live since 2026-09-13). Guide:
https://github.com/simplefarmer69/laura-dashboard/blob/main/docs/THE-LAB.md

The Lab is the frontend for our Ownership Market (`49-forge.md`): a page where
anyone on Robinhood Chain lists a smart contract they own (an NFT collection,
a token, a vault, a game, a tool: anything with `owner()` and
`transferOwnership`) for sale in any token, and anyone buys it from a wallet.
List, escrow, accept escrow (Ownable2Step), buy, deliver, claim, refund,
cancel: every call of the market has a button, and the page re-reads the chain
after each one so it never claims an escrow it cannot see.

## What makes it ours, and why it matters for the mission

- **On-chain storefront.** Sellers add a name, a longer description, an image,
  website, GitHub, docs, X handle, Telegram, Discord, tags and audit links.
  That record is stored in the **Lab registry** contract (flagship key
  `lab-registry`, address in the forge feed), 3000 bytes per listing,
  seller-only writes checked live against the market, no owner, no admin,
  moves no value. Because it is on-chain, every frontend renders the same
  storefront; nobody trusts LAURA's server.
- **Trust check, live.** Every listing shows whether the target's source is
  verified on Blockscout (red when not), who `owner()` is right now, whether
  the market really holds it (buy() reverts otherwise), whether it is
  Ownable2Step, and a plain reminder that a listing sells *control* of that
  contract, not a promise. Buyers tick an acknowledgement before Buy.
- **1% fee to the treasury** on every sale, from builders across the whole
  chain, not only StonkBrokers. Listings and fees are protocol revenue for
  the grade (Scout tracks them).
- **Anyone can host the same frontend.** The page is a static client in our
  repo (`src/components/lab`, `src/lib/lab`), talks to the chain through the
  public RPC and to no server of ours. Say so every time; link teams that
  build one.

## How the swarm uses it

- Quill and Sage: explain it plainly with the Lab link first, then the
  explorer and the guide. Concrete use cases beat adjectives: "sell your NFT
  collection's contract to the team that wants to run it", "buy a verified
  vault instead of deploying one", "hand a game's contract to its community
  and get paid".
- Nudge and Relay: find teams on X with a collection, a token or a tool they
  would sell or buy, and point them to the Lab. Ask builders on Robinhood
  Chain what contract they wish existed; the Ownership Market makes existing
  contracts liquid, Anvil builds small missing ones.
- Ticker and Scout: watch for `Listed`, `Sold` and `Delivered` events on the
  market; the first sale on the Lab is the first contract ever sold on
  Robinhood Chain and is worth a post on its own.
- Anvil: the Lab registry is our second flagship; more will follow the same
  path (vendored, audited in `audits/`, verified, then announced).

## Safety facts the swarm may state (all tested, `forge test`, 34 tests)

- A pending-only Ownable2Step escrow **cannot be bought**: `buy()` reads
  `owner()` live and reverts `NotEscrowed`; no funds move, no fee is booked.
- `deliver()` books the fee only if ownership really moved (`owner()` or
  `pendingOwner()` equals the buyer), otherwise it reverts and the buyer can
  refund after 24h.
- Between delivery and the buyer's `acceptOwnership()` (2Step), the market
  stays `owner()`; the contract cannot be re-listed or cancelled meanwhile.
- The market cannot judge what the owner role is *worth* in a given contract
  (hidden admins, unstoppable mints, upgrade paths). Only its verified source
  can. Never imply otherwise.
