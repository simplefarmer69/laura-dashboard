import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { hostInfo } from "@/lib/ops";
import { isViewerMode } from "@/lib/viewer/mode";
import { readSnapshot } from "@/lib/viewer/store";
import { loadState } from "@/lib/store";
import { isCycleRunning } from "@/lib/swarm/orchestrator";
import { runtimeActivity, schedulerRunning, startScheduler } from "@/lib/swarm/scheduler";
import { resolveModel } from "@/lib/swarm/llm";
import { missionStatus } from "@/lib/mission-status";
import { xStatus } from "@/lib/publish/x";
import { loadNotebook } from "@/lib/swarm/notebook";
import { loadSkills } from "@/lib/swarm/skills";

export const dynamic = "force-dynamic";

/* The public snapshot is ~2 MB of JSON and the console polls it every 15 s.
   Serving it uncacheable made every poll a full download, which on mobile
   connections read as "the site never loads" (operator report 2026-09-14).
   The viewer branch now serializes once, tags the body with a content ETag,
   answers If-None-Match with an empty 304, and lets the Vercel edge hold the
   body for 15 s so concurrent viewers share one function invocation. The
   serialized body + ETag are memoized per snapshot object, which readSnapshot
   already caches in-process for 10 s. */
const viewerBodyCache = new WeakMap<object, { body: string; etag: string }>();

function viewerBody(snapshot: object): { body: string; etag: string } {
  const hit = viewerBodyCache.get(snapshot);
  if (hit) return hit;
  const body = JSON.stringify(snapshot);
  const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  const entry = { body, etag };
  viewerBodyCache.set(snapshot, entry);
  return entry;
}

const VIEWER_CACHE_CONTROL = "public, max-age=0, must-revalidate, s-maxage=15, stale-while-revalidate=60";

export async function GET(request: Request) {
  /* Public viewer: serve the latest snapshot the VM published instead of the
     live store — the viewer deployment has no data dir and no swarm. */
  if (isViewerMode()) {
    const snapshot = await readSnapshot();
    if (!snapshot)
      return NextResponse.json(
        { error: "No snapshot published yet. LAURA's host has not pushed one." },
        { status: 503 },
      );
    const { body, etag } = viewerBody(snapshot);
    const headers = {
      "cache-control": VIEWER_CACHE_CONTROL,
      etag,
    };
    /* Vercel serves the body gzipped and weakens the ETag to W/"...", so
       browsers echo the weak form back — compare without the W/ prefix. */
    const inm = request.headers.get("if-none-match")?.replace(/^W\//, "");
    if (inm === etag) return new Response(null, { status: 304, headers });
    return new Response(body, {
      status: 200,
      headers: { ...headers, "content-type": "application/json" },
    });
  }

  /* Keep the autopilot on current code without a server restart: instrumentation
     only runs at boot, so after a scheduler upgrade the first poll here starts
     the V2 loop (idempotent) and retires any stale pre-V2 loop. */
  if (process.env.SWARM_AUTOPILOT !== "0") startScheduler({ firstTickDelayMs: 5_000 });

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
      activity: runtimeActivity(state),
      llmProvider: model.provider,
      llmModel: model.modelId,
      x: xStatus(),
      host: await hostInfo(),
    },
  });
}
