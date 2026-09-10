import { NextResponse } from "next/server";
import { isViewerMode, viewerForbidden } from "@/lib/viewer/mode";
import { isForumRoundRunning, runForumRound } from "@/lib/swarm/forum";

export const dynamic = "force-dynamic";
/* Rounds scale with roster size: every active agent takes an LLM turn plus the
   host sweep, so 16 agents run 13-14 minutes. 800s is Vercel's ceiling on
   plans that allow it; locally the value is ignored. */
export const maxDuration = 800;

export async function POST() {
  if (isViewerMode()) return viewerForbidden();
  if (isForumRoundRunning()) {
    return NextResponse.json({ error: "A forum round is already running" }, { status: 409 });
  }
  const result = await runForumRound();
  return NextResponse.json(result);
}
