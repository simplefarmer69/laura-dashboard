import { loadState } from "@/lib/store";
import { runCycle, runGrader } from "@/lib/swarm/orchestrator";
import { utcDate } from "@/lib/grader/score";

/**
 * Long-running scheduler. Runs a full swarm cycle every `cycleIntervalHours`
 * (read live from settings so the console can change it) and makes sure the
 * grader has stamped every UTC day even if no cycle landed on it.
 */
const TICK_MS = 60_000;
let lastCycleAt = 0;
let lastGradeDate = "";

function log(msg: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}

async function tick(): Promise<void> {
  const state = await loadState();
  const intervalMs = Math.max(1, state.settings.cycleIntervalHours) * 3_600_000;
  const latestRun = state.runs.at(-1);
  if (latestRun?.finishedAt && latestRun.finishedAt > lastCycleAt) lastCycleAt = latestRun.finishedAt;

  const today = utcDate();
  const hasGradeToday = state.grades.some((g) => g.date === today);

  if (Date.now() - lastCycleAt >= intervalMs) {
    log("starting scheduled cycle");
    const run = await runCycle("scheduler");
    lastCycleAt = Date.now();
    lastGradeDate = today;
    log(
      `cycle ${run.id} finished: ${run.draftsCreated} drafts, ${run.proposalsCreated} proposals${run.error ? `, error: ${run.error}` : ""}`,
    );
    return;
  }

  if (!hasGradeToday && lastGradeDate !== today) {
    log("stamping daily grade");
    const grade = await runGrader();
    lastGradeDate = today;
    log(`grade ${grade.date}: ${grade.letter} ${grade.score.toFixed(1)}`);
  }
}

async function main(): Promise<void> {
  log("scheduler online");
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`tick failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

void main();
