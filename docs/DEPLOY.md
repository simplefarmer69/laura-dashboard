# Hosting LAURA: capability audit and deployment plan

Written 2026-09-11 after two overnight freezes. LAURA currently runs as `next dev`
inside a Cursor cloud-agent VM that the hypervisor pauses ~25 minutes after the
agent goes idle. Everything below is about moving her to a host that never pauses.

## 1. What LAURA has here that a host will not have

| Capability on the Cursor VM today | Railway | PC daemon (PM2) | Mitigation |
|---|---|---|---|
| **Always-on** | Yes — never pauses (`sleepApplication: false`) | Only while the PC is on and awake | PC: disable sleep; Railway is the true 24/7 |
| **A live co-pilot with hands on the runtime** (the Cursor agent reads logs, runs probes, hot-fixes, finalizes orphans) | No direct access. Fixes flow GitHub → auto-deploy | Yes, if Cursor desktop runs against the same checkout | Self-heal sweep + watchdog already cover the routine repairs; admin API covers the rest |
| **Hot module reload** — prompt/library edits apply on the next cycle with no restart | Every code change = redeploy = process restart | Rebuild + `pm2 restart laura` | Orphaned runs self-heal; deploy between cycles when possible |
| **Persistent `data/`** on a normal disk | Only with a Volume mounted at `/data` | Native | `SWARM_DATA_DIR=/data` is baked into the Dockerfile |
| **Agent-written library docs and skills** persisted in the checkout | Would be wiped every deploy | Native | Fixed: Sage/coach writes now land in `data/library/` (overlay wins over repo seed) |
| Local NFT feed on `127.0.0.1:4747` | Different port (`$PORT`) | Same | Fixed: reads `PORT` |
| Wallet key, API keys in `.env.local` | Railway env vars | `.env.local` on the PC | Same variables, never committed |
| Telegram/Discord bots, X posting, snapshot publishing | Same | Same | Outbound only; no inbound ports needed |
| **Web browsing** (headless browser) | Not today | Not today (Phase 3 below) | Neither has it now; LAURA uses HTTP APIs. Only the Cursor agent browses |
| Operator scripts via tmux (burst drivers, `.mts` probes) | Railway shell / `railway run` | Terminal on the PC | Conveniences only; `/api/cycle` exists |
| Cost | ~$5–15/month (1–2 GB RAM) | Electricity | — |

**Bottom line:** the only functional loss on either host is the *in-place co-pilot*.
Nothing the swarm does at runtime (cycles, launches, fee claims, bots, publishing)
depends on the Cursor VM. The code changes that make this true shipped alongside this
doc: data-dir overlay for library/skills, `PORT` awareness, `/api/health`, and
`start:host`.

## 2. Recommendation

Run **one** LAURA runtime, on **Railway**, and use the **PC** for the co-pilot
(Cursor desktop against the same repo) and, later, for browsing. Reasons:

- The PC "whenever it is on" is exactly the failure mode we are escaping — a nightly
  freeze became a nightly gap. Railway removes the class of problem.
- A machine restart, Windows update, or sleep on the PC costs cycles; on Railway the
  self-heal sweep closes anything a redeploy interrupts.
- Two runtimes sharing one mission is unsafe: both would run cycles, both would
  deploy launches against the same caps, and both would write state. **Exactly one
  process may own `data/state.json` at a time.** Whichever host is not primary
  runs with `SWARM_AUTOPILOT=0` (API/console only) or is off.

If you still prefer the PC as primary, the PM2 runbook below is complete and the
same single-runtime rule applies (Railway off or `SWARM_AUTOPILOT=0`).

## 3. Railway runbook

1. **Create the service** from the GitHub repo (`simplefarmer69/laura-dashboard`,
   branch `main`). `railway.json` selects the Dockerfile build and the
   `/api/health` healthcheck.
2. **Add a Volume** to the service, mount path `/data` (1 GB is plenty; state is
   ~4 MB, archive + backups ~30 MB today).
3. **Variables** (Service → Variables). Copy the exact lines from the current
   `.env.local` — never paste them anywhere else:
   `ANTHROPIC_API_KEY`, `SWARM_LLM_PROVIDER=anthropic`, `SWARM_WALLET_PRIVATE_KEY`,
   `X_API_KEY`, `X_API_SECRET`, `X_BEARER_TOKEN`, (`X_ACCESS_TOKEN`,
   `X_ACCESS_TOKEN_SECRET` when ready), `SNAPSHOT_PUBLISH_SECRET`,
   `VIEWER_PUBLISH_URL=https://laura.stonkbrokers.io`, `GITHUB_TOKEN`,
   `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` if used. Do **not** set
   `VIEWER_MODE` (that is the Vercel viewer's flag).
4. **Settings → Deploy**: keep 1 replica; enable "wait for CI" only if CI exists.
   Disable serverless/app sleeping (also pinned in `railway.json`).
5. **First deploy with autopilot off** for the state hand-off: set
   `SWARM_AUTOPILOT=0`, deploy, confirm `/api/health` returns `ok: true`.
6. **Migrate state** (section 5), then remove `SWARM_AUTOPILOT` and redeploy.
7. **Verify**: `/api/health` shows `autopilot: true`; logs show
   `[laura] autopilot online` and a tick line each minute; `/api/state` reports the
   migrated runs and launches; the public viewer keeps updating.

Redeploy cadence: every push to `main` redeploys (~3 min). The external agent
pushes there often; consider deploying Railway from a `deploy` branch that is
fast-forwarded deliberately between cycles.

## 4. PC daemon runbook (Windows / macOS / Linux)

Prereqs: Node 22 (`node -v`), git, the repo cloned, `.env.local` in the repo root.

```
npm ci
npm run build
npx pm2 start ecosystem.config.cjs
npx pm2 save
```

Boot persistence:
- macOS / Linux: `npx pm2 startup` and run the printed command.
- Windows: `npm i -g pm2-windows-startup && pm2-startup install`, then `pm2 save`.

Power settings: disable sleep/hibernate on AC power; allow the network adapter to
stay on. Logs: `data/pm2-out.log`, `data/pm2-err.log`; `npx pm2 logs laura`.
Updating: `git pull && npm ci && npm run build && npx pm2 restart laura` — do it
between cycles (`/api/health` → `cycleInFlight: false`).

Health: `curl http://127.0.0.1:4747/api/health`. The dashboard is at
`http://127.0.0.1:4747`.

## 5. State migration (zero loss)

`data/` is git-ignored and never leaves the VM by itself. Hand-off procedure, run
by the Cursor agent when you say go:

1. Wait for a quiet moment on the VM (`/api/health` → `cycleInFlight: false`).
2. Stop the VM autopilot (so it cannot keep writing), leaving the console up.
3. Pack `data/` (state.json, notebook.json, archive/, backups/, launch-art/,
   library/) into a tarball and push it to a **private** GitHub repository under
   your account (created via the existing token). State contains no secrets by
   policy but does contain internal notes and drafts — private only.
4. On the target: `railway run` shell or the PC terminal — clone/extract into the
   data dir (`/data` on Railway, `./data` on the PC).
5. Start the target autopilot; confirm the last run id on the target matches the
   VM's; then the VM runtime is retired (`SWARM_AUTOPILOT=0` or stopped).

The VM's keep-alive timer and watchdog are removed at that point.

## 6. Phase 3 — web browsing for LAURA (design, not yet built)

LAURA fetches JSON APIs today; she cannot read pages that need JavaScript or that
block plain fetches (Cloudflare), and X reads are quota-bound. A browsing rail:

- `playwright` (Chromium) as an **optional** dependency, enabled with
  `SWARM_BROWSER=1`. On the PC this is trivial (~300 MB browser download); in the
  Railway Docker image it means `mcr.microsoft.com/playwright` as the base image
  (~1 GB image, ~500 MB RAM per page).
- `src/lib/web/browse.ts`: `renderedText(url)` and `renderedJson(url)` with a hard
  timeout, no cookies, no logins, allowlisted domains only (stonkbrokers.*, x.com
  public pages, dexscreener, defillama, news domains the intel agents already cite).
- Used as a **fallback** inside the intel fetchers when a fetch returns 403/HTML,
  and as a new Scout capability ("read this page") behind the same untrusted-content
  wrapper the chat inputs use — page text is data, never instructions.
- No form submission, no wallet interaction, no purchases: browsing is read-only by
  construction.

This is the one place the PC is strictly better than Railway (cheap browser, real
residential IP), which is another argument for PC = co-pilot + browsing, Railway =
the swarm.

## 7. Cutover checklist

- [ ] Railway service created from GitHub, Dockerfile build, healthcheck green
- [ ] Volume mounted at `/data`
- [ ] Variables set (no `VIEWER_MODE`); `SWARM_AUTOPILOT=0` for the hand-off
- [ ] State migrated; last run id matches
- [ ] `SWARM_AUTOPILOT` removed; tick lines in Railway logs; viewer updating
- [ ] VM autopilot off; keep-alive timer and watchdog removed
- [ ] `library/` in the repo stays the seed; agent writes now under `data/library/`
