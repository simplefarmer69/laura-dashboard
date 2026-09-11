import { NextResponse } from "next/server";
import { loadState, redactSecrets } from "@/lib/store";
import { schedulerRunning } from "@/lib/swarm/scheduler";
import { isCycleRunning } from "@/lib/swarm/orchestrator";
import { isForumRoundRunning, lastForumPostAt } from "@/lib/swarm/forum";
import { authorized, flagPending, opsEnabled, releaseInfo, RESTART_FLAG, tailLog, UPDATE_FLAG } from "@/lib/ops";

export const dynamic = "force-dynamic";

/** Co-pilot status: process, release, swarm progress, pending daemon flags, daemon log tail. */
export async function GET(req: Request) {
  if (!opsEnabled()) return new NextResponse(null, { status: 404 });
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const state = await loadState();
  const now = Date.now();
  const runs = state.runs.slice(-3).map((r) => ({
    id: r.id,
    startedMinAgo: Math.round((now - r.startedAt) / 60_000),
    finished: Boolean(r.finishedAt),
    steps: r.steps.length,
    error: r.error ? redactSecrets(r.error).slice(0, 200) : null,
  }));
  const agents = state.agents.map((a) => ({
    id: a.id,
    status: a.status,
    lastRunMinAgo: a.lastRunAt ? Math.round((now - a.lastRunAt) / 60_000) : null,
    strategyVersion: a.strategyVersion,
  }));
  const events = state.events.slice(-12).map((e) => `${new Date(e.ts).toISOString()} ${e.kind} ${redactSecrets(e.title)}`);
  return NextResponse.json({
    ok: true,
    now: new Date(now).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    release: await releaseInfo(),
    autopilot: schedulerRunning(),
    cycleInFlight: isCycleRunning(),
    forumRoundInFlight: isForumRoundRunning(),
    lastForumPostMinAgo: lastForumPostAt(state) ? Math.round((now - lastForumPostAt(state)) / 60_000) : null,
    settings: {
      cycleIntervalMinutes: state.settings.cycleIntervalMinutes,
      maxLlmCyclesPerDay: state.settings.maxLlmCyclesPerDay,
    },
    grade: state.grades.at(-1) ? { date: state.grades.at(-1)!.date, score: state.grades.at(-1)!.score } : null,
    runs,
    agents,
    events,
    flags: { updateRequested: await flagPending(UPDATE_FLAG), restartRequested: await flagPending(RESTART_FLAG) },
    daemonLog: await tailLog("daemon.log", 40),
  });
}
