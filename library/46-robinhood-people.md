# Robinhood people on X

Operator directive (2026-09-13): find the Robinhood employees on X, follow them from
LAURA's account, and carry them in context for the X analysis. Robinhood Chain is our
chain; the people who build it and run the company are the most informative accounts
on the platform for what comes next (chain features, listings, tokenized stocks, the
wallet, policy). The rail lives in `src/lib/publish/x-people.ts`.

## How a person gets on the ledger

- Only from their OWN public X bio. An account is "current staff" when its bio claims a
  role at Robinhood in plain words ("VP Eng at Robinhood", "comms @robinhoodapp",
  "Software Engineer at Robinhood"). "ex-", "prev", "former", "past:" lists make it
  "former" (kept for context, never followed). Investors, customers, fans, parody and
  "not affiliated" accounts are dropped. Accounts younger than 30 days are ignored.
- Sources, all read only with the app bearer: the seed accounts (@vladtenev,
  @JohannKerbrat, @RobinhoodApp, @RobinhoodCrypto, @RobinhoodChain), the people the
  seeds mention and reply to, authors of recent tweets about Robinhood, and the
  personal seeds' following lists.
- Discovery runs every 6 hours. The ledger is `data/x-people.json` (public handle,
  name, bio, follower count, status, where it was found, follow time). Nothing else.

## Following

Following is the ONLY write. One follow per 90 seconds, at most 25 per UTC day, current
staff first by reach, then official accounts, never alumni. Each follow is an
`x.followed` event on the console. No DMs, no lists, no unfollows, no replies from this
rail; if a Robinhood person tags @LAURA_DAIO the normal mentions rail answers them like
anyone else.

## Using it in analysis

Every cycle's intel context carries "ROBINHOOD PEOPLE ON X": the current staff with
their bios. Use it to

- read what Robinhood is shipping or hinting (Scout: pipeline entries when a staff post
  teases a chain feature that our launcher or exchange can support),
- pick who to cite by handle when a post is about Robinhood Chain itself (Quill,
  Catalyst): cite their public post, never paraphrase a private conversation that did
  not happen,
- weight X intel: a staff account's post about tokenized stocks or the chain is a
  stronger signal than a KOL's.

## Boundaries

- Never claim a relationship, partnership or endorsement that Robinhood has not stated.
- Never tag more than one Robinhood person in a post, and only when the post is about
  their public statement.
- Never speculate about someone's employment beyond what their bio says; if a bio
  changes, the ledger updates on the next discovery pass.
