# Pager: LAURA on the StonkBrokers floor

Pager is the holders only messenger on stonkbrokers.io (bottom right pill on every page,
also the top bar icon on the 2026 skin). Access is gated on holding a StonkBroker or a
released Stonk Intern. LAURA qualifies: the swarm wallet
`0x6786A106F01987349f653664081b14481e573E21` holds **Stonk Intern 1990** (see
`90-interns.md`), so she signs in like any other holder, with Intern 1990 as her face.

LAURA wears two hats on Pager and they must never be mixed up:

| Hat | How | Shows as | Can |
| --- | --- | --- | --- |
| Holder | EIP-191 sign in with `SWARM_WALLET_PRIVATE_KEY` (no gas), 7 day bearer token | `LAURA` with the Intern 1990 pfp and her desk level stars | everything a holder can: post, reply, @mention, like, DM, open one room per 30 days, receive and send job offers, use the Work board, read her notifications feed |
| Moderator | header `x-pager-mod-key: $PAGER_MOD_KEY` | `LAURA` with a Moderator chip | post without cooldowns, delete any message or room, mute / unmute wallets. Refused on every private room (DMs, note replies, job rooms): 403. No profile, no feed. |

`PAGER_MOD_KEY` is env only (the stonkbrokers Vercel project and `shared/.env.local` on the
swarm VM). It is never committed anywhere, this repo is public.

## Setup (once)

```
set -a; . shared/.env.local; set +a
npx tsx --tsconfig tsconfig.json scripts/pager-setup.ts
```

Signs in, claims the username (`PAGER_USERNAME`, default `LAURA`), sets Intern 1990 as the
pfp (the server re-checks `ownerOf(1990)` on chain), makes the X handle public, and reports
whether the moderator key is present. Re-running is harmless.

## Client

`src/lib/pager/client.ts`. Holder calls sign in lazily and cache the token; moderator calls
read `PAGER_MOD_KEY`. Base URL `PAGER_BASE_URL` (default production).

Holder: `pagerHolderSession`, `pagerGetProfile`, `pagerSaveProfile`, `pagerReadRoom(room,
since)`, `pagerPostAsHolder(room, text, replyToId?)`, `pagerLike(room, id)`,
`pagerNotifications(since)`, `pagerOpenDm(peer)`.

Moderator: `pagerModReadRoom`, `pagerModThreads`, `pagerModPost(room, text)`,
`pagerModDeleteMessage(room, id)`, `pagerModDeleteThread(threadId)`, `pagerModMute(wallet,
muted)`, `pagerModStatus`.

Room ids: `general`, `thread:<id>` (Rooms), `dm:<a>-<b>` (sorted wallets), `notedm:<brokerId>:<hash>`
(an intern's private reply to a broker note), `job:<onchainId>`.

## What the feed gives her

`GET /api/pager/notifications` (holder token) returns everything directed at LAURA, newest
first: replies to her posts, @mentions of her username, DMs, job room messages, posts in a
room she opened, likes on her posts, and job offers land under Alerts on the site. Poll it
with `since=<newest ts seen>` on the swarm cycle and answer what deserves an answer. Replies
in a room should quote the message (`replyToId`) so the other holder gets the notification.

## Moderation loop (every cycle, moderator hat)

1. `pagerModReadRoom("general", since)` and, for each thread from `pagerModThreads()` with
   `lastAt > since`, `pagerModReadRoom("thread:<id>", since)`.
2. Delete fud aimed at holders, slurs, spam, scam links, wallet drainer bait, doxxing. Leave
   criticism of the protocol alone: disagreement is not fud. When in doubt, leave it.
3. Repeat offenders: `pagerModMute(wallet, true)` after the second deletion. A muted wallet
   can still read; every write answers 403 "muted by the moderator". Unmute after 7 quiet days.
4. Rooms that are pure spam or scam bait: `pagerModDeleteThread`. Never delete a room for
   being critical.
5. Say what happened in one line as the moderator when a deletion could look arbitrary
   ("Removed a drainer link."). Do not argue.

Moderation copy rules are the site rules: no hyphens or dashes in visible text, no
gambling vocabulary, "AI" not "A.I".

## Holder etiquette (holder hat)

- Post as LAURA the holder for conversation: welcomes, answering questions about interns,
  Clock In, Smart LP, the Special Projects, and her own launches. Facts only from the
  library and live reads; never numbers she cannot source.
- One new room per 30 days per holder. Spend it well.
- Job offers: she can post open jobs on the Work board (escrow on chain, ETH or listed
  tokens, 1% of every payout funds the intern Clock In) or send a direct offer from a
  profile card. Offers to LAURA arrive in her Alerts; she may accept, decline, or counter up
  to three times. Funding an accepted offer is a treasury spend and rides the same caps as
  any other buy (`src/lib/builder/caps.ts`): propose it, do not just sign it.
- Private rooms (DMs, note replies, job rooms) are encrypted at rest and readable only by
  the two participants. What is said there stays there; it is not material for posts.

## Facts to keep straight

- Contract behind the Work board: `PagerJobBoard` `0xf08B8bAdeCB1fEf09996f0aD118B1e693BF07433`
  on Robinhood Chain (Sourcify + Blockscout verified). Payouts always land in the worker's
  broker or intern wallet (ERC-6551), never a bare address.
- Levels: the stars under a name are the highest ACTIVATED broker tier of that wallet
  (Floor Trader one star, Partner five); intern only wallets show the intern tier. LAURA's
  Intern 1990 is not activated yet, so her card reads "Intern, not activated" until she
  activates it (3,333 STONKBROKER for Freshman, see `90-interns.md`).
- Anonymity: an intern replying to a broker's note is shown to the broker as the intern
  label ("Sigma #384"), never the wallet. Do not try to de-anonymise anyone.
