import { loadState } from "@/lib/store";
import { runCycle, runGrader } from "@/lib/swarm/orchestrator";
import { utcDate } from "@/lib/grader/score";

/**
 * LAURA's autopilot. Runs a full cycle every `cycleIntervalHours` (read live from
 * settings so the console can change it) and makes sure the grader has stamped
 * every UTC day even if no cycle landed on it. Safe to call more than once per
 * process: only the first call starts the loop.
 */
const TICK_MS = 60_000;

declare global {
  var __lauraScheduler: { started: boolean; lastCycleAt: number; lastGradeDate: string } | undefined;
}

function log(msg: string): void {
  console.log(`[laura ${new Date().toISOString()}] ${msg}`);
}

export function schedulerRunning(): boolean {
  return globalThis.__lauraScheduler?.started ?? false;
}

async function tick(): Promise<void> {
  const s = globalThis.__lauraScheduler;
  if (!s) return;
  const state = await loadState();
  const intervalMs = Math.max(1, state.settings.cycleIntervalHours) * 3_600_000;
  const latestRun = state.runs.at(-1);
  if (latestRun?.finishedAt && latestRun.finishedAt > s.lastCycleAt) s.lastCycleAt = latestRun.finishedAt;

  const today = utcDate();
  const hasGradeToday = state.grades.some((g) => g.date === today);

  if (Date.now() - s.lastCycleAt >= intervalMs) {
    log("starting scheduled cycle");
    const run = await runCycle("scheduler");
    s.lastCycleAt = Date.now();
    s.lastGradeDate = today;
    log(
      `cycle ${run.id} finished: ${run.draftsCreated} drafts, ${run.proposalsCreated} proposals${run.error ? `, error: ${run.error}` : ""}`,
    );
    return;
  }

  if (!hasGradeToday && s.lastGradeDate !== today) {
    log("stamping daily grade");
    const grade = await runGrader();
    s.lastGradeDate = today;
    log(`grade ${grade.date}: ${grade.letter} ${grade.score.toFixed(1)}`);
  }
}

export function startScheduler(options: { firstTickDelayMs?: number } = {}): void {
  if (globalThis.__lauraScheduler?.started) return;
  globalThis.__lauraScheduler = { started: true, lastCycleAt: 0, lastGradeDate: "" };
  log("autopilot online");
  const loop = async () => {
    for (;;) {
      try {
        await tick();
      } catch (err) {
        log(`tick failed: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  };
  setTimeout(() => void loop(), options.firstTickDelayMs ?? 0);
}
