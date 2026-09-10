import { NextResponse } from "next/server";
import { isViewerMode } from "@/lib/viewer/mode";
import { readSnapshot } from "@/lib/viewer/store";
import { loadState } from "@/lib/store";
import { isCycleRunning } from "@/lib/swarm/orchestrator";
import { schedulerRunning } from "@/lib/swarm/scheduler";
import { resolveModel } from "@/lib/swarm/llm";
import { missionStatus } from "@/lib/mission-status";
import { xStatus } from "@/lib/publish/x";
import { loadNotebook } from "@/lib/swarm/notebook";
import { loadSkills } from "@/lib/swarm/skills";

export const dynamic = "force-dynamic";

export async function GET() {
  /* Public viewer: serve the latest snapshot the VM published instead of the
     live store — the viewer deployment has no data dir and no swarm. */
  if (isViewerMode()) {
    const snapshot = await readSnapshot();
    if (!snapshot)
      return NextResponse.json(
        { error: "No snapshot published yet — LAURA's host has not pushed one." },
        { status: 503 },
      );
    return NextResponse.json(snapshot, { headers: { "cache-control": "no-store" } });
  }

  const state = await loadState();
  const model = resolveModel(state.settings.llmModel);
  const [notebook, skills] = await Promise.all([loadNotebook(), loadSkills()]);
  return NextResponse.json({
    ...state,
    metricsHistory: state.metricsHistory.slice(-600),
    intelHistory: (state.intelHistory ?? []).slice(-200),
    mission: missionStatus(state, state.metricsHistory.at(-1) ?? null),
    /* Evolution ledger: the self-authored knowledge that shows development over time. */
    evolution: {
      notebookCount: notebook.length,
      notebook: notebook.slice(-15).reverse(),
      skills: skills.map((s) => ({ name: s.name, description: s.description, agents: s.agents })),
    },
    runtime: {
      cycleRunning: isCycleRunning(),
      autopilot: schedulerRunning(),
      llmProvider: model.provider,
      llmModel: model.modelId,
      x: xStatus(),
    },
  });
}
