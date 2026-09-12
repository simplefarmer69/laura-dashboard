import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * OAuth 2.0 token keeper for the X posting rail. The operator's token has
 * offline.access, so it arrives as a pair: an access token that dies in ~2
 * hours and a refresh token that mints a new pair forever. X ROTATES the
 * refresh token on every use, so the live pair must be stored outside env
 * (env still holds the seed pair the operator installed). Storage is
 * <DATA_DIR>/x-oauth2.json, mode 600, and token values are never logged.
 *
 * Refresh needs the app's OAuth 2.0 Client ID (X_OAUTH2_CLIENT_ID, from the
 * developer portal's OAuth 2.0 section; X_OAUTH2_CLIENT_SECRET too when the
 * app is a confidential client). Until that is set, this module degrades to
 * exactly the old behavior: serve the env token and let a 401 pause the rail.
 *
 * The token expired once already (2026-09-12 ~15:30 UTC, no offline.access
 * then) and posting was down for hours; this module is why that cannot
 * repeat.
 */

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "x-oauth2.json");

/** X access tokens live ~2h; renew with headroom so a post never rides an old token. */
const REFRESH_AFTER_MS = 75 * 60_000;
/** After a failed refresh, keep serving the current token and retry this much later. */
const RETRY_AFTER_MS = 10 * 60_000;

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** When accessToken was obtained (ms). */
  obtainedAt: number;
  /** The env refresh token this chain was seeded from; a new env install reseeds. */
  seedRefreshToken: string;
}

declare global {
  var __lauraXOauth2: { inFlight: Promise<string> | null; lastFailAt: number } | undefined;
}

function mem(): { inFlight: Promise<string> | null; lastFailAt: number } {
  if (!globalThis.__lauraXOauth2) globalThis.__lauraXOauth2 = { inFlight: null, lastFailAt: 0 };
  return globalThis.__lauraXOauth2;
}

function log(msg: string): void {
  console.log(`[x-oauth2 ${new Date().toISOString()}] ${msg}`);
}

async function readStore(): Promise<StoredTokens | null> {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredTokens;
    return parsed.accessToken && parsed.refreshToken ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStore(t: StoredTokens): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(t, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** The live pair: the stored chain when it descends from the current env seed, else a fresh seed from env. */
async function livePair(): Promise<StoredTokens | null> {
  const envAccess = process.env.X_OAUTH2_ACCESS_TOKEN ?? "";
  const envRefresh = process.env.X_OAUTH2_REFRESH_TOKEN ?? "";
  const stored = await readStore();
  if (stored && (!envRefresh || stored.seedRefreshToken === envRefresh)) return stored;
  if (!envAccess) return stored;
  /* New operator install (or first run): start the chain from the env pair.
     obtainedAt is unknown, so assume now; a stale assumption just means one
     401-and-refresh instead of a proactive refresh. */
  const seeded: StoredTokens = {
    accessToken: envAccess,
    refreshToken: envRefresh,
    obtainedAt: Date.now(),
    seedRefreshToken: envRefresh,
  };
  await writeStore(seeded);
  if (stored) log("env token changed; token chain reseeded from the new install");
  return seeded;
}

async function refreshNow(current: StoredTokens): Promise<string> {
  const clientId = process.env.X_OAUTH2_CLIENT_ID;
  if (!clientId) throw new Error("X_OAUTH2_CLIENT_ID not set (developer portal → app → OAuth 2.0 Client ID)");
  if (!current.refreshToken) throw new Error("no refresh token on file (token was issued without offline.access)");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const secret = process.env.X_OAUTH2_CLIENT_SECRET;
  if (secret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    ...(secret ? {} : { client_id: clientId }),
  });
  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`token refresh failed (${res.status}): ${json.error ?? "?"} ${json.error_description ?? ""}`.trim());
  }
  await writeStore({
    accessToken: json.access_token,
    /* X rotates the refresh token; keep the old one only if none came back. */
    refreshToken: json.refresh_token ?? current.refreshToken,
    obtainedAt: Date.now(),
    seedRefreshToken: current.seedRefreshToken,
  });
  log("access token refreshed (next proactive refresh in ~75m)");
  return json.access_token;
}

/**
 * The OAuth 2.0 access token to send right now. Proactively refreshes when
 * the current one is older than 75 minutes; on refresh failure serves the
 * current token anyway (the 401 path in the rails handles a dead one) and
 * backs off 10 minutes before trying again. Single-flight per process.
 */
export async function currentOauth2Token(): Promise<string> {
  const m = mem();
  if (m.inFlight) return m.inFlight;
  const run = (async () => {
    const pair = await livePair();
    if (!pair) return "";
    const age = Date.now() - pair.obtainedAt;
    if (age < REFRESH_AFTER_MS || Date.now() - m.lastFailAt < RETRY_AFTER_MS) return pair.accessToken;
    try {
      return await refreshNow(pair);
    } catch (err) {
      m.lastFailAt = Date.now();
      log(`proactive refresh failed, serving current token: ${String(err)}`);
      return pair.accessToken;
    }
  })();
  m.inFlight = run.finally(() => {
    m.inFlight = null;
  });
  return m.inFlight;
}

/**
 * Called by the posting path after a 401: force one refresh regardless of
 * age. Returns the new token, or null when refresh is impossible or failed
 * (the caller then falls back to the pause-and-stay-queued behavior).
 */
export async function forceOauth2Refresh(): Promise<string | null> {
  const m = mem();
  if (Date.now() - m.lastFailAt < RETRY_AFTER_MS) return null;
  const pair = await livePair();
  if (!pair) return null;
  try {
    return await refreshNow(pair);
  } catch (err) {
    m.lastFailAt = Date.now();
    log(`forced refresh failed: ${String(err)}`);
    return null;
  }
}
