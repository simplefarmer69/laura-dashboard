import { NextResponse } from "next/server";
import { isViewerMode, viewerForbidden } from "@/lib/viewer/mode";
import { runGrader } from "@/lib/swarm/orchestrator";

export const dynamic = "force-dynamic";

export async function POST() {
  if (isViewerMode()) return viewerForbidden();
  const grade = await runGrader();
  return NextResponse.json(grade);
}
