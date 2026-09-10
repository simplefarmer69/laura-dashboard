import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isViewerMode } from "@/lib/viewer/mode";
import { readSnapshot, storeSnapshot } from "@/lib/viewer/store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** ~10x current state size; a snapshot bigger than this is a bug, not data. */
const MAX_BODY_BYTES = 8_000_000;

function secretMatches(header: string | null): boolean {
  const secret = process.env.SNAPSHOT_PUBLISH_SECRET;
  if (!secret || !header) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

/**
 * Snapshot ingest for the PUBLIC VIEWER. The operator's VM pushes a sanitized
 * state snapshot here (see lib/viewer/publish.ts) authenticated with the
 * shared SNAPSHOT_PUBLISH_SECRET. Disabled everywhere except viewer mode.
 */
export async function POST(req: NextRequest) {
  if (!isViewerMode())
    return NextResponse.json({ error: "Snapshot ingest only exists on the public viewer" }, { status: 404 });
  if (!process.env.SNAPSHOT_PUBLISH_SECRET)
    return NextResponse.json({ error: "SNAPSHOT_PUBLISH_SECRET not configured" }, { status: 503 });
  if (!secretMatches(req.headers.get("authorization")))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    return NextResponse.json({ error: "Snapshot too large" }, { status: 413 });
  let snapshot: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    snapshot = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  try {
    const storage = await storeSnapshot(snapshot);
    return NextResponse.json({ ok: true, storage });
  } catch (err) {
    return NextResponse.json({ error: `Store failed: ${String(err)}` }, { status: 500 });
  }
}

/** Public, harmless freshness probe: is a snapshot available and how old is it. */
export async function GET() {
  if (!isViewerMode())
    return NextResponse.json({ error: "Snapshot ingest only exists on the public viewer" }, { status: 404 });
  const snap = await readSnapshot();
  const viewer = (snap?.viewer ?? null) as { publishedAt?: number } | null;
  return NextResponse.json({
    hasSnapshot: Boolean(snap),
    publishedAt: viewer?.publishedAt ?? null,
  });
}
