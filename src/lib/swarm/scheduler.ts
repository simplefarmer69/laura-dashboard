import os from "node:os";
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

/**
 * Capacity guard: the swarm grows only within what this machine can carry.
 * A scheduled cycle is deferred (never dropped — the next tick retries) when
 * the 1-minute load average exceeds the core count or free memory is under
 * 300 MB. Operator-triggered cycles are unaffected.
 */
function machineBusy(): string | null {
  const cores = os.cpus().length || 1;
  const load1 = os.loadavg()[0];
  if (load1 > cores) return `load ${load1.toFixed(1)} > ${cores} cores`;
  const freeMb = os.freemem() / 1_048_576;
  if (freeMb < 300) return `free memory ${freeMb.toFixed(0)} MB < 300 MB`;
  return null;
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
    const busy = machineBusy();
    if (busy) {
      log(`deferring scheduled cycle: ${busy}`);
      return;
    }
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
