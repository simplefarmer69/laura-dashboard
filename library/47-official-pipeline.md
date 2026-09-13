# Official pipeline: what the team is building next (operator directive 2026-09-13)

## The rule

The StonkBrokers team announces and teases its own upcoming work on the
official accounts (@ClutchMarkets, and the founder @OxSimpleFarmer). Every
special project, partner launch, collaboration or product drop that appears
there is a project the swarm SUPPORTS by default: its token will come through
the Stonk Launcher and its trading through the Stonk Exchange, so its volume
and fees are protocol revenue for $STONKBROKER holders. The operator's words:
"laura should also use official comms posts to learn about upcoming special
projects we have in the works as we should support them, their tokens will
come through our infra."

## How it flows

- The intel digest carries an OFFICIAL COMMS block every cycle: the latest
  originals from the operator accounts, long enough to read (up to 400 chars),
  five per account.
- Scout reads that block and returns `pipeline` entries in the research brief:
  project, status (teased, announced, live, partner), the source post with
  handle and date, and how the swarm should support it.
- Each entry lands in the notebook as `Official pipeline: <project>` and ships
  to every agent through the library digest. Re-recording a project replaces
  its entry, so the notebook always holds the current story, never a stale one.
- Producers, Mint, Broker (bd) and Relay act on the entries: content angles
  that prepare the audience, outreach that lines up partners or liquidity,
  launch timing that does not collide with an official drop, and support once
  it is live.

## What support means, concretely

- Quill and Nudge: prepare the audience honestly, with what the official post
  actually said. Never announce a date or a detail the team has not.
- Broker (bd): when a partner is named, the ask is the LP pairing rule from
  85-special-projects.md: quote the pair in $STONKBROKER, launch on the stonk
  lane, or route through the Stonk Exchange.
- Mint: do not launch a look-alike of an announced official project; the
  floor should be clear for the official token when it comes. A companion
  concept that points at the official project is fine when the team's post
  makes the project public.
- Purser: official-project tokens launched by the team are NOT LAURA's own
  tokens; they are eco positions like any other builder's, inside ECO_CAPS.
- Ledger and Watcher: once live, track its volume as mission volume.

## Boundaries

- Only what the official accounts publicly posted counts. A rumour, a reply
  or a quote from anyone else is not pipeline.
- No dates, prices or mechanics beyond the official text. "Teased" means
  teased; say so.
- The operator can also drop a pipeline note directly into the notebook
  through the console; treat it the same way.
