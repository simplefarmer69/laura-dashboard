import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  archiveStats,
  gradeHistory,
  notebookHistory,
  recentOutputs,
  searchArchive,
  type ArchiveStream,
} from "@/lib/swarm/archive";
import type { AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Storage-health + deep-memory retrieval surface.
 *   GET /api/archive                       → stats (row counts, DB size, last backup)
 *   GET /api/archive?q=text[&streams=a,b] → full-text search across the archive
 *   GET /api/archive?agent=narrative&n=5  → that agent's latest archived outputs
 *   GET /api/archive?grades=30            → grade history from the archive
 *   GET /api/archive?notebook=topic       → every archived revision of a notebook topic
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const n = Math.min(Math.max(Number(p.get("n")) || 8, 1), 50);

  const q = p.get("q");
  if (q) {
    const streams = p.get("streams")?.split(",").filter(Boolean) as ArchiveStream[] | undefined;
    return NextResponse.json({ query: q, hits: searchArchive(q, n, streams) });
  }
  const agent = p.get("agent");
  if (agent) {
    return NextResponse.json({ agent, outputs: recentOutputs(agent as AgentId, n) });
  }
  const grades = p.get("grades");
  if (grades) {
    return NextResponse.json({ grades: gradeHistory(Math.min(Number(grades) || 30, 365)) });
  }
  if (p.has("notebook")) {
    return NextResponse.json({ entries: notebookHistory(p.get("notebook") || undefined, n) });
  }
  return NextResponse.json(archiveStats());
}
