# Integrations — verified wire formats

Every format here was verified live during the build. Do not guess variants; these work.

## Smart Launch V2 deploys (chain 4663)

- Deploying is **THREE calls, not one**: (1) `createLaunch(tuple)` payable — registers
  the launch and mints supply **to the creator wallet**; (2) ERC-20 `approve(pad,
  supplyWei)` on the new token; (3) `arm(id, supplyWei)` on the pad — loads the supply
  and **starts the sale clock**. A launch that is created but not armed sits on the
  floor as "waiting" with `startTime 0` forever and never goes live. Check
  `getLaunch(id).armed` before arming (idempotent).
- WETH lane `0xFCd6…EC9f` — use `LAUNCHPAD.pads.weth` in code, never retype addresses.
  Fee from `launchFeeWei()` (currently 0 — a full create+approve+arm costs gas only,
  well under 0.001 ETH). Live `bounds()`: start mcap $1k–$1M, graduation $50k–$10M
  (≥2x start), buffer ≥600s, max start tax 9900 bps.
- **Our WETH pad IS the Stonklauncher UI's active ETH lane** (verified 2026-09-10 from
  the live client bundle after the "not visible" scare). The site keys it `weth2`; the
  /launcher lane menu defaults to it (`XJ.find(e => e.key === "weth2")`) and organic
  launches land on it. Other pads that look tempting but are NOT the UI write path:
  the bundle's legacy native pad `0xEcA5…71f9` (creation disabled — `launchFeeWei`
  returns the 1e24-wei sentinel) and the newer `weth22` pad `0x5BCE…a3B3` (present in
  config but hidden by the lane menu filter). Floor ids are `laneIdOffset + launchId`
  (weth2 offset 18,000,000 → launch #276 = floor id 18000276).
- Always simulate before send; parse the `LaunchCreated` event for launch id + token.
- Vanity salt zero, `unsoldMode` 0, `openEnded` true, `bondVenue` 0 are the proven params.

## Launcher branding API (stonkbrokers.cash)

- **Upload logo**: `POST /api/launcher/token-image` with raw image bytes
  (`Content-Type: image/webp`) → `{ok, imageHash}` (content-addressed keccak; readback
  at `/api/launcher/token-image/<hash>`). Retry up to 3x with 1.2s·n backoff; don't
  retry 4xx except 429. Logos: 256px WebP, **48KB cap**.
- **Attach logo** (creator wallet only): sign exactly
  `["StonkBrokers Safe Launch logo", "chain: <id>", "token: <addr lowercase>",
  "image: <hash lowercase>", "signed at: <ISO>"].join("\n")`
  → `POST /api/safe-launch/token-logo` `{token, imageHash, signedAt, signature}`.
- **Attach profile links** (creator wallet only): same pattern, header line
  `"StonkBrokers Safe Launch profile"`, fields `x / website / telegram`
  → `POST /api/safe-launch/token-profile`. Website must be full https://; telegram
  `https://t.me/…` or `@handle`.

## Public reads

- Factory-curve grid: `GET /api/launcher/tokens?sort=new`. For Safe Launch tokens it
  also carries the UI route (`safeHref`, e.g. `/safe-launch/token/weth2-laura-276`)
  and the attached `imageHash`.
- **`GET /api/safe-launch/floor` is THE surface the /launcher (Stonklauncher) UI
  renders from** — the client bundle fetches it and filters client-side. A launch is
  user-visible only when its floor row reports phase `live` (or `bonded`/
  `graduated`); a created-but-unarmed launch sits as `waiting` among 100+ others and
  is effectively invisible. `verifyLaunchVisible()` in `service.ts` checks exactly
  this; the executor runs it after every arm.
  `GET /api/launcher/token/<addr>` returns "unknown token" for
  Safe Launch deploys — that is normal, not an error.
- Batch logo map: `GET /api/safe-launch/token-logo?tokens=<a>,<b>`.
- Also available: `/api/safe-launch/stats`, `/leaderboard`, `/mcap-series`, `/buys`.

## X (Twitter)

- `POST https://api.x.com/2/tweets` signed OAuth 1.0a HMAC-SHA1 (no SDK; `node:crypto`).
  Threads = reply chains, 280-char sentence-boundary splits, 1.2s between posts.
- App key/secret + bearer are on file; **bearer is read-only** — posting waits on the
  operator's access token pair (Read & Write).

## LLM

- Provider: Anthropic via Vercel AI SDK. Model: **claude-fable-5-1** (operator-granted;
  key also exposes claude-fable-5, claude-opus-5, claude-sonnet-5 for fallback).
- Structured output: generous zod caps + one-shot schema-repair retry (feed the
  validation error and raw output back). Pin `TODAY (UTC)` into producer prompts.

## Chat connectors (built, awaiting tokens)

- Telegram long-polling (`getUpdates`): DMs always; groups only /commands, @mentions,
  replies-to-bot. Discord via discord.js (needs Message Content intent;
  `serverExternalPackages: ["discord.js"]` in next.config.ts or the build breaks).
