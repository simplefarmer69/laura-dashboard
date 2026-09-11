import { NextResponse } from "next/server";
import { schedulerRunning } from "@/lib/swarm/scheduler";
import { isCycleRunning } from "@/lib/swarm/orchestrator";

export const dynamic = "force-dynamic";

/**
 * Liveness probe for hosts (Railway healthcheck, PM2, the watchdog). Cheap by
 * design: no state load, no chain reads — /api/state is the heavy endpoint.
 * Reports the autopilot flag so a host can tell "process up" from "swarm
 * ticking".
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    autopilot: schedulerRunning(),
    cycleInFlight: isCycleRunning(),
    viewerMode: process.env.VIEWER_MODE === "1" || process.env.NEXT_PUBLIC_VIEWER_MODE === "1",
  });
}
