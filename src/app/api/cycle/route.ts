import { NextResponse } from "next/server";
import { isCycleRunning, runCycle } from "@/lib/swarm/orchestrator";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  if (isCycleRunning()) {
    return NextResponse.json({ error: "A cycle is already running" }, { status: 409 });
  }
  const run = await runCycle("manual");
  return NextResponse.json(run, { status: run.error ? 500 : 200 });
}
