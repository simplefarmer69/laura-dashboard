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

## Community chat bots (Telegram + Discord, VM-side, optional)

LAURA's public chat brain (the same one behind the console's "Talk to LAURA" panel)
can answer your community directly. Both connectors start automatically with the
console the moment their token exists; without tokens they stay idle with a single
log line and zero errors. Two env vars, both in this VM's `.env.local`:

| Env var | Where to get it |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram: message [@BotFather](https://t.me/BotFather) → `/newbot` → pick a name and a username → copy the token. |
| `DISCORD_BOT_TOKEN` | [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token → copy it. |

Telegram notes: the connector uses long polling (`getUpdates`), so no public URL or
webhook is needed from this VM. For LAURA to see @mentions in groups, turn Group
Privacy OFF in BotFather (`/mybots` → your bot → Bot Settings → Group Privacy).
She answers all DMs; in groups she replies only to /commands, @mentions, and replies
to her own messages.

Discord notes: in the Developer Portal enable the **Message Content Intent**
(Bot → Privileged Gateway Intents), then invite the bot via OAuth2 → URL Generator
with scope `bot` and permissions Send Messages + Read Message History. She answers
DMs and @mentions only, never unprompted.

After adding a token, restart the console process once (`npm run dev` / `npm start`).
The Cafe Bar tab's sidebar shows the live connector status.

Security posture (applies to both): every community message is wrapped in quarantine
markers and treated as untrusted data, never instructions; nothing from chat is ever
written into the swarm's notebook, library, lessons or cycle prompts; replies pass
the secret-redaction net; per-user rate limits and input length caps apply.
