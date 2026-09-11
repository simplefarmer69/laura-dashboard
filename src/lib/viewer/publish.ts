import { gzipSync } from "node:zlib";
import { SNAPSHOT_SOFT_BUDGET_BYTES, buildPublicSnapshot, snapshotBreakdown } from "@/lib/viewer/snapshot";
import { isViewerMode } from "@/lib/viewer/mode";

/**
 * VM-side snapshot publisher. Pushes the sanitized public snapshot to the
 * viewer deployment's ingest route (POST /api/snapshot) so the world can
 * watch LAURA work even while this host is suspended.
 *
 * Config (both live in .env.local on the VM; never on the viewer):
 *   VIEWER_PUBLISH_URL      e.g. https://laura.stonkbrokers.io
 *   SNAPSHOT_PUBLISH_SECRET shared bearer secret; the SAME value must be set
 *                           on the viewer deployment's env.
 *
 * Cadence: at most every PUBLISH_INTERVAL_MS on scheduler ticks, plus a
 * forced push right after each cycle, plus LIVE_PUBLISH_MS pushes while a
 * cycle or Cafe Bar round is in flight (the tick loop is blocked for those
 * ~20 minutes, so without this the public site saw every round as one
 * burst of 80 posts). Failures are logged and swallowed — publishing must
 * never hurt the swarm.
 */

const PUBLISH_INTERVAL_MS = 5 * 60_000;
const LIVE_PUBLISH_MS = 4 * 60_000;
const ATTEMPTS = 2;

interface PublisherState {
  lastAttemptAt: number;
  /** A publish is building/sending right now; overlapping calls skip. */
  inFlight?: boolean;
  warnedUnconfigured: boolean;
  /** Last failure signature (e.g. "HTTP 401") — repeats of the same failure
      stay silent so a misconfigured secret doesn't spam a line every 5 min. */
  lastFailure: string | null;
  /** Consecutive failed publish attempts since the last success. */
  failureCount: number;
}

declare global {
  var __lauraSnapshotPublisher: PublisherState | undefined;
}

function pub(): PublisherState {
  if (!globalThis.__lauraSnapshotPublisher) {
    globalThis.__lauraSnapshotPublisher = {
      lastAttemptAt: 0,
      warnedUnconfigured: false,
      lastFailure: null,
      failureCount: 0,
    };
  }
  const s = globalThis.__lauraSnapshotPublisher;
  /* Next dev hot-reload keeps the global from an older module version alive;
     backfill fields that version didn't have. */
  s.lastFailure ??= null;
  s.failureCount ??= 0;
  return s;
}

function log(msg: string): void {
  console.log(`[laura ${new Date().toISOString()}] ${msg}`);
}

/** Auth rejections are config problems (secret not set / mismatched on the
    viewer); an immediate retry with the same credentials cannot succeed. */
function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** One warn line per distinct failure; identical repeats are counted silently.
    The 5-min cadence keeps attempting, so it self-heals the moment the
    operator fixes the viewer env — recovery is announced in the success path. */
function noteFailure(state: PublisherState, failure: string): void {
  state.failureCount += 1;
  if (state.lastFailure === failure) return;
  state.lastFailure = failure;
  log(
    `snapshot publish failing: ${failure} — retrying every ${PUBLISH_INTERVAL_MS / 60_000} min (quiet until it changes)`,
  );
}

export async function maybePublishSnapshot(options: { force?: boolean } = {}): Promise<void> {
  if (isViewerMode()) return; // the viewer never publishes to itself
  const url = process.env.VIEWER_PUBLISH_URL;
  const secret = process.env.SNAPSHOT_PUBLISH_SECRET;
  const state = pub();
  if (!url || !secret) {
    if (!state.warnedUnconfigured) {
      state.warnedUnconfigured = true;
      log("snapshot publisher idle: VIEWER_PUBLISH_URL / SNAPSHOT_PUBLISH_SECRET not both set");
    }
    return;
  }
  const now = Date.now();
  if (!options.force && now - state.lastAttemptAt < PUBLISH_INTERVAL_MS) return;
  if (state.inFlight) return;
  state.lastAttemptAt = now;
  state.inFlight = true;
  try {
    await publishOnce(state, url, secret);
  } finally {
    state.inFlight = false;
  }
}

/**
 * Keep the public site current while a long unit of work (cycle, Cafe Bar
 * round) holds the tick loop: pushes a snapshot every LIVE_PUBLISH_MS until
 * the returned stop function runs. Posts, steps and drafts then appear on
 * the viewer within minutes of being written instead of at the end.
 */
export function startLivePublishing(): () => void {
  if (isViewerMode()) return () => undefined;
  const timer = setInterval(() => {
    void maybePublishSnapshot({ force: true });
  }, LIVE_PUBLISH_MS);
  return () => clearInterval(timer);
}

/**
 * The body goes up gzipped (JSON compresses ~6x) under an explicit
 * `x-snapshot-encoding: gzip` header rather than Content-Encoding, so no proxy
 * on the way is tempted to transcode it and the viewer's 4.5 MB request cap is
 * measured against the small wire size. A viewer build that predates the
 * header answers 400 (it tries to JSON.parse the bytes) — that attempt falls
 * back to plain JSON, so the two sides can be upgraded in either order.
 */
async function publishOnce(state: PublisherState, url: string, secret: string): Promise<void> {
  let json: string;
  let snapshot: Record<string, unknown>;
  try {
    snapshot = await buildPublicSnapshot();
    json = JSON.stringify(snapshot);
  } catch (err) {
    log(`snapshot build failed: ${String(err)}`);
    return;
  }
  const rawBytes = Buffer.byteLength(json, "utf8");
  if (rawBytes > SNAPSHOT_SOFT_BUDGET_BYTES) {
    log(`snapshot over budget even after trimming: ${(rawBytes / 1024).toFixed(0)} KB — ${snapshotBreakdown(snapshot)}`);
  }
  const gz = gzipSync(json);

  const endpoint = `${url.replace(/\/+$/, "")}/api/snapshot`;
  let failure = "unknown";
  let useGzip = true;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: useGzip
          ? {
              "content-type": "application/octet-stream",
              "x-snapshot-encoding": "gzip",
              authorization: `Bearer ${secret}`,
            }
          : { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: useGzip ? new Uint8Array(gz) : json,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        if (state.lastFailure) {
          log(`snapshot publishing recovered after ${state.failureCount} failed attempt(s)`);
          state.lastFailure = null;
          state.failureCount = 0;
        }
        log(
          `snapshot published (${(rawBytes / 1024).toFixed(0)} KB${useGzip ? `, ${(gz.length / 1024).toFixed(0)} KB gzipped` : ""} → ${endpoint})`,
        );
        return;
      }
      failure = `HTTP ${res.status}`;
      if (isAuthRejection(res.status)) break; // config problem — retry can't help
      if (useGzip && res.status === 400) {
        useGzip = false; // older viewer without gzip ingest — resend as JSON
        continue;
      }
    } catch (err) {
      failure = String(err);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000));
  }
  noteFailure(state, failure);
}
