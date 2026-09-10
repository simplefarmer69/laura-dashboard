import { buildPublicSnapshot } from "@/lib/viewer/snapshot";
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
 * forced push right after each cycle. Failures are logged and swallowed —
 * publishing must never hurt the swarm.
 */

const PUBLISH_INTERVAL_MS = 5 * 60_000;
const ATTEMPTS = 2;

interface PublisherState {
  lastAttemptAt: number;
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
  state.lastAttemptAt = now;

  let body: string;
  try {
    body = JSON.stringify(await buildPublicSnapshot());
  } catch (err) {
    log(`snapshot build failed: ${String(err)}`);
    return;
  }

  const endpoint = `${url.replace(/\/+$/, "")}/api/snapshot`;
  let failure = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        if (state.lastFailure) {
          log(`snapshot publishing recovered after ${state.failureCount} failed attempt(s)`);
          state.lastFailure = null;
          state.failureCount = 0;
        }
        log(`snapshot published (${(body.length / 1024).toFixed(0)} KB → ${endpoint})`);
        return;
      }
      failure = `HTTP ${res.status}`;
      if (isAuthRejection(res.status)) break; // config problem — retry can't help
    } catch (err) {
      failure = String(err);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000));
  }
  noteFailure(state, failure);
}
