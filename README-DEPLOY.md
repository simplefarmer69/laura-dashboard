# Deploying the public viewer — laura.stonkbrokers.io

The LAURA console ships with a **viewer mode**: a public, read-only deployment where
anyone can watch LAURA work. Every mutation route returns 403, no scheduler/bots/executor
run, no LLM or wallet keys exist there, and the UI renders with all controls disabled.
The operator's local console (this VM, port 4747) stays fully interactive and pushes
sanitized state snapshots to the viewer every ~5 minutes (plus after each cycle).

```
VM (private, sleeps)                      Vercel (public, always up)
┌──────────────────────────┐   POST       ┌───────────────────────────────┐
│ console + swarm + keys   │  snapshot    │ same repo, VIEWER_MODE=1      │
│ scheduler tick ──────────┼─────────────▶│ /api/snapshot → Vercel Blob   │
│ (sanitized, ~5 min)      │  bearer      │ /api/state ← latest snapshot  │
└──────────────────────────┘  secret      │ all mutations → 403           │
                                          └───────────────────────────────┘
```

No Vercel credentials exist on this VM, so the operator must do the deploy once.
Everything below is prepared; it is ~10 minutes of clicking or two CLI commands.

## 1. Create the Vercel project

Dashboard route: [vercel.com/new](https://vercel.com/new) → import this repository →
Framework preset **Next.js** (auto-detected) → **before deploying**, open
*Environment Variables* and add:

| Name | Value | Notes |
| --- | --- | --- |
| `VIEWER_MODE` | `1` | server-side enforcement (403s, no scheduler) |
| `NEXT_PUBLIC_VIEWER_MODE` | `1` | client-side disabled controls + banner |
| `SNAPSHOT_PUBLISH_SECRET` | *(the value from this VM's `.env.local`)* | must match exactly; treat like a password |

Do **NOT** add `ANTHROPIC_API_KEY`, `SWARM_WALLET_PRIVATE_KEY`, any `X_*` keys, or any
other secret from the VM's `.env.local`. The viewer must not have them.

Then click **Deploy**.

CLI alternative (from a machine with this repo cloned and `npm i -g vercel` done):

```bash
vercel link                     # create/link the project
vercel env add VIEWER_MODE production          # enter: 1
vercel env add NEXT_PUBLIC_VIEWER_MODE production   # enter: 1
vercel env add SNAPSHOT_PUBLISH_SECRET production   # paste the secret from .env.local
vercel --prod
```

## 2. Attach a Blob store (snapshot storage)

Project → **Storage** → **Create Database** → **Blob** → attach to the project
(this injects `BLOB_READ_WRITE_TOKEN` automatically) → **Redeploy** so the env var
takes effect. Without Blob the ingest route falls back to instance-local `/tmp`,
which does not survive serverless cold starts — fine for a smoke test, not for production.

## 3. Add the custom domain

Project → **Settings → Domains** → add `laura.stonkbrokers.io`.

Then at the DNS provider for `stonkbrokers.io`, add exactly one record:

```
Type:   CNAME
Name:   laura
Value:  cname.vercel-dns.com
TTL:    default/auto
```

Vercel verifies the record and issues TLS automatically (usually minutes).

## 4. Nothing to do on the VM

`.env.local` here already contains `SNAPSHOT_PUBLISH_SECRET` (generated) and
`VIEWER_PUBLISH_URL=https://laura.stonkbrokers.io`. The scheduler already attempts a
push every ~5 minutes and right after each cycle; failures are logged and harmless.
As soon as the domain resolves, snapshots start landing with no restart needed.
Manual push any time:

```bash
set -a; . ./.env.local; set +a
npx tsx --tsconfig tsconfig.json scripts/publish-snapshot.ts
```

## 5. Verify

- `https://laura.stonkbrokers.io/api/snapshot` → `{"hasSnapshot":true,"publishedAt":…}`
- The page shows the **LIVE VIEW** banner with "updated Xs ago".
- `curl -X POST https://laura.stonkbrokers.io/api/cycle` → HTTP 403.
- Every button/input on the site is disabled; the local console on the VM is not.

## What the viewer serves (and what it never sees)

Included (all of it already public or LAURA-authored): grades, agents + strategies,
drafts, proposals, runs, launches + procedural art, treasury summary (on-chain public),
events, lessons, evolution notebook/skills, intel history, launchpad pad/grid state.

Excluded by whitelist: every env value, API keys, wallet private key, publish secret,
the names of missing credentials, the SQLite archive (`/api/archive` is 403 on the
viewer), and chat (each message costs Anthropic tokens — `/api/chat` POST is 403).
