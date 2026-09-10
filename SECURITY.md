# Security Policy

## Reporting a vulnerability

Please report security issues privately to **simple@clutch.market**. Do not
open a public issue for anything exploitable.

Include what you found, where (file, route, or commit), and how to reproduce
it. You will get a response as fast as we can manage, and credit if you want
it.

## Scope

Things we care about most:

- Ways to reach a mutation on the public viewer deployment (every mutating
  API route must be blocked by `VIEWER_MODE`).
- Ways to forge or bypass the snapshot ingest auth (`SNAPSHOT_PUBLISH_SECRET`
  bearer check in `src/app/api/snapshot/route.ts`).
- Ways to make the swarm exceed its code-level spend caps (launchpad
  executor, treasury caps, builder caps).
- Prompt-injection paths from public feed data into actions that spend funds
  or publish content.

## What is NOT in this repo

No secrets live in this repository or its git history. Wallet keys, LLM API
keys, social platform tokens, and the snapshot publish secret exist only in
operator-managed environment variables. If you believe you found a secret in
the history, report it privately; it will be rotated.
