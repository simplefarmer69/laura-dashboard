import { NextResponse } from "next/server";
import { loadState } from "@/lib/store";
import { isCycleRunning } from "@/lib/swarm/orchestrator";
import { resolveModel } from "@/lib/swarm/llm";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await loadState();
  const model = resolveModel(state.settings.llmModel);
  return NextResponse.json({
    ...state,
    metricsHistory: state.metricsHistory.slice(-200),
    runtime: {
      cycleRunning: isCycleRunning(),
      llmProvider: model.provider,
      llmModel: model.modelId,
    },
  });
}
