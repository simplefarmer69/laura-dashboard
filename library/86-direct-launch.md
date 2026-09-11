# Direct launch / BYO-ERC20 play (operator-requested 2026-09-11)

The operator wants LAURA able to launch tokens where she **mints ~99% of supply to
herself, LPs on Uniswap, and locks the LP in the Safety Deposit Box** — full
autonomous token issuance beyond the standard curve allocation.

## The route that exists today (verified surface)

The V2 pad's `createLaunch` takes a `token` address field. LAURA passes the zero
address (pad mints a fresh token); the official docs list **"Bring your own ERC20"**
as a first-class launch mode. That is the play:

1. Deploy an ERC20, mint the full supply to the swarm wallet.
2. Keep the retention share (up to ~99%) in the wallet.
3. Pass the token address + the curve share to `createLaunch` on the chosen lane —
   the pad runs its normal Guaranteed Bond raise on the curve share.
4. At graduation the pad itself mints the LP into the **Safety Deposit Box** ("a
   permanent locker with no unlock and no admin key") — no manual Uniswap LP or lock
   step needed; LAURA keeps the lock NFT's 80% fee stream as usual.

The pad validates BYO tokens on-chain (`FeeOnTransferToken`, `TokenIsQuoteAsset`,
`TokenInUse` errors exist), so a plain OpenZeppelin-style ERC20 is required — no
transfer taxes.

## The one blocker

**No ERC20 bytecode is available in this runtime.** There is no Solidity toolchain
here, and the Builder's vendored templates (FaucetDrip, BurnPledge) do not include a
mintable ERC20. Everything after "deploy an ERC20" is proven infrastructure.

Unblock options (operator/external agent):
- Vendor audited ERC20 creation bytecode (OpenZeppelin ERC20, fixed supply to
  deployer) into the repo the way the Builder templates are vendored; or
- Provide a trusted on-chain token factory address on chain 4663 LAURA can call.

Once either lands, wire a `byoToken` path through `deployLaunch` (the `token` param
is already in the ABI struct) and gate it under the same LAUNCH_CAPS — no cap
changes needed.

## Disclosure doctrine (charter-bound)

A 99%-retention launch concentrates supply with the creator. If LAURA ships one, the
broadcast MUST state the retention plainly (e.g. "LAURA holds 99% of this supply and
here is why") — the charter's no-deception rule applies with extra force. Retention
without disclosure reads as a rug setup and is forbidden regardless of caps.

## What was tested and rejected meanwhile (2026-09-11 simulations)

Buy-only curves (`sellsEnabled=false` → `BadEconomics()`) and closed sale windows
(`openEnded=false` → `BadParam()`) revert on all 8 V2 pads in every combination —
those modes are launcher-side toggles LAURA cannot reach today. Accepted and now
available to Mint: `eoaOnly`, `maxBuyPpm`, `bondVenue 1`, `unsoldMode 1`.
