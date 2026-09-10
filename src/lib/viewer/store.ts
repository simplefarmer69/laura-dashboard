import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { head, put } from "@vercel/blob";

/**
 * Snapshot persistence for the PUBLIC VIEWER deployment. The operator's VM
 * publishes a sanitized state snapshot (see snapshot.ts / publish.ts); this
 * module stores the latest one and serves it back to the viewer's read routes.
 *
 * Storage ladder:
 *  1. Vercel Blob when BLOB_READ_WRITE_TOKEN is present (the production path —
 *     serverless instances share it and it survives cold starts).
 *  2. A local file fallback (dev/self-hosted viewer, local verification runs).
 *  3. An in-process cache in front of both, so 15-second console polls don't
 *     hammer Blob.
 *
 * Deliberately light on imports: this is the only swarm module the viewer's
 * hot path needs, and it must never pull in the store/archive/scheduler stack.
 */

const BLOB_PATHNAME = "laura/console-snapshot.json";
const CACHE_TTL_MS = 10_000;

function fallbackFile(): string {
  return process.env.VIEWER_SNAPSHOT_FILE ?? path.join(os.tmpdir(), "laura-viewer-snapshot.json");
}

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

interface SnapshotCache {
  data: Record<string, unknown> | null;
  at: number;
}

declare global {
  var __lauraViewerSnapshotCache: SnapshotCache | undefined;
}

function cache(): SnapshotCache {
  if (!globalThis.__lauraViewerSnapshotCache) {
    globalThis.__lauraViewerSnapshotCache = { data: null, at: 0 };
  }
  return globalThis.__lauraViewerSnapshotCache;
}

/** Persists the latest published snapshot. Returns where it landed. */
export async function storeSnapshot(snapshot: Record<string, unknown>): Promise<"blob" | "file"> {
  const c = cache();
  c.data = snapshot;
  c.at = Date.now();
  const json = JSON.stringify(snapshot);
  if (blobConfigured()) {
    await put(BLOB_PATHNAME, json, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
    });
    return "blob";
  }
  const file = fallbackFile();
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, file);
  return "file";
}

/** Latest snapshot, or null when nothing has been published yet. */
export async function readSnapshot(): Promise<Record<string, unknown> | null> {
  const c = cache();
  if (c.data && Date.now() - c.at < CACHE_TTL_MS) return c.data;

  let data: Record<string, unknown> | null = null;
  if (blobConfigured()) {
    try {
      const meta = await head(BLOB_PATHNAME);
      const res = await fetch(meta.url, { cache: "no-store" });
      if (res.ok) data = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not published yet, or Blob unreachable — fall through */
    }
  }
  if (!data) {
    try {
      data = JSON.parse(await fs.readFile(fallbackFile(), "utf8")) as Record<string, unknown>;
    } catch {
      /* no local fallback either */
    }
  }
  if (data) {
    c.data = data;
    c.at = Date.now();
  }
  return data ?? c.data;
}
