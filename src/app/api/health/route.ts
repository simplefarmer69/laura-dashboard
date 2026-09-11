import { NextResponse } from "next/server";
import { schedulerRunning } from "@/lib/swarm/scheduler";
import { isCycleRunning } from "@/lib/swarm/orchestrator";
import { isForumRoundRunning } from "@/lib/swarm/forum";
import { chainWorkInFlight } from "@/lib/chain-work";

export const dynamic = "force-dynamic";

/**
 * Liveness probe for hosts (Railway healthcheck, PM2, the watchdog). Cheap by
 * design: no state load, no chain reads — /api/state is the heavy endpoint.
 * Reports the autopilot flag so a host can tell "process up" from "swarm
 * ticking", and `busy` (a cycle, a Cafe Bar round, or chain work such as a
 * launch deploy / arm / treasury buy in flight) so the daemon kit only
 * switches releases at a genuinely quiet moment. Chain work was added after
 * a release switch landed 12 s into the $GRADED deploy (2026-09-11).
 */
export function GET() {
  const cycleInFlight = isCycleRunning();
  const forumRoundInFlight = isForumRoundRunning();
  const chainWork = chainWorkInFlight();
  return NextResponse.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    autopilot: schedulerRunning(),
    cycleInFlight,
    forumRoundInFlight,
    chainWork,
    busy: cycleInFlight || forumRoundInFlight || chainWork.length > 0,
    viewerMode: process.env.VIEWER_MODE === "1" || process.env.NEXT_PUBLIC_VIEWER_MODE === "1",
  });
}
