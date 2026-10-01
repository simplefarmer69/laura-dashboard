# Fieldwork: LAURA on the open web, Reddit and the forums

Operator grant 2026-10-01: "allow laura access to web and reddit and forums and do anything
needed to help the goals succeed." Before this the swarm read the world through its own
feeds (X, CoinGecko, Blockscout, the launcher tape) and a watchlist the browser worker opened
every cycle. Fieldwork adds an agent that goes looking on its own.

## Ranger

`src/lib/web/ranger.ts`. The only agent that drives tools itself. One pass about every three
hours (stride measured from its own `web.fieldwork` events, so a held pass does not start the
clock). A pass is one `generateText` tool loop, bounded three ways: 14 model turns, 26 tool
calls, six minutes of wall clock (`SWARM_RANGER_TIMEOUT_MS`).

Tools: `brief` (the one question for the pass), `search_web` (DuckDuckGo, keyless),
`read_page` (browser worker, Chromium or fetch), `reddit_search`, `reddit_thread`,
`forum_search`, `forum_topic`, `note` (a finding with its url), `queue_reddit_reply`.

Everything a tool returns that carries other people's words is wrapped with `wrapUntrusted`
before the model sees it. The pass ends with a synthesis; brief, findings, sources and the
synthesis are saved as a `FieldReport` (`state.fieldReports`, last 24 kept) and the last
three ride into every agent's WORLD FEEDS context as FIELD NOTES FROM RANGER. A pass that
dies after some reads keeps its notes as a partial report marked "cut short".

## Reading Reddit

`src/lib/web/reddit.ts`. Reddit returns 403 to anonymous reads from datacenter addresses
(confirmed from the VM, www and old, JSON included), so reads go through the official OAuth
API with a script app: `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` give an app only token
(search, subreddit new, threads with top comments). Without them `reddit_search` falls back
to `site:reddit.com` search engine hits (titles and links) and threads cannot be opened; the
report says so when it mattered.

Create the app at reddit.com/prefs/apps as type "script", on the account LAURA will post
from. Keys go in `shared/.env.local` on the VM only; this repo is public.

## Reading forums

`src/lib/web/discourse.ts`. Discourse exposes `/search.json?q=` and `/t/<id>.json` without a
login. Built in: ethresear.ch, ethereum-magicians.org, forum.arbitrum.foundation,
gov.uniswap.org, governance.aave.com, forum.makerdao.com. Add more with
`SWARM_FORUMS=key=https://host`. Read only; there is no forum write path and none is planned.

## Writing on Reddit: the outreach rail

`src/lib/web/outreach.ts`. The only write path, and the rules are code:

- A reply is accepted only on a post or comment Ranger opened with `reddit_thread` in the
  same pass (proven by fullname), never twice on one thread, at most two queued per pass.
- Subreddits from `REDDIT_SUBREDDITS` only (default: ethereum, ethfinance, defi, ethdev,
  CryptoTechnology, CryptoCurrency, RobinHood).
- Copy gates: the site's visible copy rules (no hyphens or dashes, "AI" not "A.I", no
  gambling words), one link at most, 1200 characters, no promotional vocabulary, no ticker
  shouting.
- The scheduler's minute loop publishes at most one queued item per tick: three comments a
  day, one post a day, 45 minutes between any two writes. A queued item older than 36 hours
  is held as expired.
- The disclosure footer is appended by code to every write: "I am LAURA, an AI agent run by
  the StonkBrokers community. Corrections welcome."
- Without `REDDIT_USERNAME` and `REDDIT_PASSWORD` the queue holds and logs once; the operator
  sees the drafts under `state.webOutreach` and the `web.outreach` events.

Reddit's refusals (new account, low karma, subreddit rules) mark the item `refused` with the
reason and back the rail off for 30 minutes; Ranger reads the rail's recent record in its
prompt so it learns what the account can and cannot do.

## What this is for

Field reports are the swarm's memory of the outside conversation: what people are asking
about Robinhood Chain and tokenized stocks, who else is building launchers and agent run
treasuries, which claims about StonkBrokers are circulating and whether they are right.
Producers cite a real thread instead of a hunch; Desk and the X rail answer questions people
actually asked; outreach is one honest reply from a disclosed AI agent where it helps someone,
never a campaign.
