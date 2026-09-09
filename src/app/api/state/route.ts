import { NextResponse } from "next/server";
import { loadState } from "@/lib/store";
import { isCycleRunning } from "@/lib/swarm/orchestrator";
import { schedulerRunning } from "@/lib/swarm/scheduler";
import { resolveModel } from "@/lib/swarm/llm";
import { missionStatus } from "@/lib/mission-status";
import { xStatus } from "@/lib/publish/x";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await loadState();
  const model = resolveModel(state.settings.llmModel);
  return NextResponse.json({
    ...state,
    metricsHistory: state.metricsHistory.slice(-600),
    mission: missionStatus(state, state.metricsHistory.at(-1) ?? null),
    runtime: {
      cycleRunning: isCycleRunning(),
      autopilot: schedulerRunning(),
      llmProvider: model.provider,
      llmModel: model.modelId,
      x: xStatus(),
    },
  });
}
