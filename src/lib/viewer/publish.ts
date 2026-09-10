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

declare global {
  var __lauraSnapshotPublisher: { lastAttemptAt: number; warnedUnconfigured: boolean } | undefined;
}

function pub() {
  if (!globalThis.__lauraSnapshotPublisher) {
    globalThis.__lauraSnapshotPublisher = { lastAttemptAt: 0, warnedUnconfigured: false };
  }
  return globalThis.__lauraSnapshotPublisher;
}

function log(msg: string): void {
  console.log(`[laura ${new Date().toISOString()}] ${msg}`);
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
        log(`snapshot published (${(body.length / 1024).toFixed(0)} KB → ${endpoint})`);
        return;
      }
      log(`snapshot publish rejected: HTTP ${res.status} (attempt ${attempt}/${ATTEMPTS})`);
    } catch (err) {
      log(`snapshot publish failed: ${String(err)} (attempt ${attempt}/${ATTEMPTS})`);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000));
  }
}
