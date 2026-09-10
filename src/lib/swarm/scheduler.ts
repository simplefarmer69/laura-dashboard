import os from "node:os";
import { loadState } from "@/lib/store";
import { acquireCycleLock, releaseCycleLock } from "@/lib/swarm/cycle-lock";
import { hasPendingApprovals, sweepPendingApprovals } from "@/lib/swarm/autonomy";
import { runCycle, runGrader } from "@/lib/swarm/orchestrator";
import { runLaunchExecutor } from "@/lib/launchpad/executor";
import { runEarningsMaintenance } from "@/lib/launchpad/earnings";
import { runTreasuryTick } from "@/lib/launchpad/treasury";
import { runSmartLpTick } from "@/lib/launchpad/smart-lp";
import { runBuilderTick } from "@/lib/builder/executor";
import { maybePublishSnapshot } from "@/lib/viewer/publish";
import { utcDate } from "@/lib/grader/score";
import type { SwarmEventKind, SwarmState } from "@/lib/types";

/**
 * LAURA's autopilot. Cascade design: the per-minute tick does only cost-free
 * checks (launch queue, budget, capacity, trigger events); LLM cycles run on a
 * base cadence of `cycleIntervalMinutes` (read live from settings) PLUS early
 * event-driven cycles when something worth reacting to lands (a launch goes
 * live, a milestone hits). A hard rolling-24h budget (`maxLlmCyclesPerDay`)
 * bounds API cost whatever the cadence and triggers do. The grader is stamped
 * every UTC day even if no cycle landed on it. Safe to call more than once per
 * process: only the first call starts the loop.
 */
const TICK_MS = 60_000;
const DAY_MS = 86_400_000;

/** Minimum gap between cycles even when trigger events fire back-to-back. */
const MIN_EVENT_GAP_MS = 20 * 60_000;

/** Event kinds that justify running a cycle early. Deliberately excludes kinds
 *  emitted inside every cycle (grade.stamped, drafts, …) to avoid self-trigger loops.
 *  intel.catalyst is safe: it is deduped per tweet id, so one founder engagement
 *  triggers exactly one early reaction cycle. */
const TRIGGER_KINDS: SwarmEventKind[] = [
  "launch.deployed",
  "launch.armed",
  "milestone.reached",
  "intel.catalyst",
];

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

/** Cycles started in the rolling 24h window, whatever their trigger. */
export function cyclesInLast24h(state: SwarmState, now = Date.now()): number {
  return state.runs.filter((r) => r.startedAt > now - DAY_MS).length;
}

/** Trigger events recorded since the last cycle finished. */
function pendingTriggerEvent(state: SwarmState, sinceTs: number): string | null {
  const hit = state.events.find((e) => e.ts > sinceTs && TRIGGER_KINDS.includes(e.kind));
  return hit ? `${hit.kind}: ${hit.title}` : null;
}

async function tick(): Promise<void> {
  const s = globalThis.__lauraScheduler;
  if (!s) return;
  /* Public-viewer feed: push a sanitized snapshot on a ~5-min cadence (the
     guard lives inside; non-fatal on failure, no-op until configured). */
  void maybePublishSnapshot();
  const state = await loadState();
  const intervalMs = Math.max(30, state.settings.cycleIntervalMinutes) * 60_000;
  /* Anchor cadence to the latest run's activity, not only to finished runs:
     a run orphaned by a dev-server restart never gets finishedAt, and anchoring
     on 0 would make every fresh process fire a cycle immediately (and treat
     ancient events as fresh triggers). */
  const latestRun = state.runs.at(-1);
  if (latestRun) s.lastCycleAt = Math.max(s.lastCycleAt, latestRun.finishedAt ?? latestRun.startedAt);

  const today = utcDate();
  const hasGradeToday = state.grades.some((g) => g.date === today);

  /* Full proposal autonomy: sweep anything still waiting on review. Idempotent —
     only "pending" items move, so once the backlog clears this is a no-op. */
  if (state.settings.autoApproveProposals && hasPendingApprovals(state)) {
    const swept = await sweepPendingApprovals();
    if (swept > 0) log(`auto-approved ${swept} pending item(s)`);
  }

  /* Full launch autonomy: work the launch queue every tick (fails closed on
     wallet, caps and pad bounds; deploys at most one launch per tick). Runs
     when a spec awaits deploy, a deployed launch still needs its supply
     armed (the repair case that turns "waiting" tokens live), OR an armed
     launch still lacks its visibility proof — without that last arm the
     executor's verify pass never runs once everything is armed and the queue
     is empty (SPEAKS #278 sat unverified for hours this way). */
  const launchWork = state.launches.some(
    (l) =>
      l.status === "approved" ||
      (l.status === "deployed" && (!l.armedAt || (l.tokenAddress && !l.verifiedAt))),
  );
  if (state.settings.autoExecuteLaunches && launchWork) {
    await runLaunchExecutor();
  }

  /* Earnings watch: cheap on-chain snapshot every ~10 min (interval guard and
     error handling live inside; never throws). Claims send only when
     settings.autoClaimEarnings is true. */
  await runEarningsMaintenance(state);

  /* Treasury ops: capped $STONKBROKER accumulation buys (mission-token only).
     All gates live inside (TREASURY_CAPS, floor, executor-busy skip); the
     pure-math eligibility pre-check makes idle ticks free. Never throws. */
  await runTreasuryTick(state);

  /* Smart LP (Stonk Exchange vDEX): pairs accumulated STONK with ETH into one
     full-range position, stakes it for $UP, and refreshes position values.
     Same fail-closed caps/floor/executor-skip discipline. Never throws. */
  await runSmartLpTick(state);

  /* Utility builder ops: ships approved dashboard builds every tick; chain
     actions (bag buys, template deploys) additionally require the operator's
     autoExecuteUtility flag and stay inside BUILDER_CAPS. Never throws. */
  await runBuilderTick(state);

  const sinceLastCycle = Date.now() - s.lastCycleAt;
  const due = sinceLastCycle >= intervalMs;
  const used = cyclesInLast24h(state);
  const triggerEvent =
    !due && sinceLastCycle >= MIN_EVENT_GAP_MS ? pendingTriggerEvent(state, s.lastCycleAt) : null;

  if (due || triggerEvent) {
    /* Another process (or one killed mid-cycle, recently) may own an in-flight
       cycle: defer while the newest run is unfinished and younger than 15 min. */
    if (latestRun && !latestRun.finishedAt && Date.now() - latestRun.startedAt < 15 * 60_000) {
      return;
    }
    if (used >= state.settings.maxLlmCyclesPerDay) {
      /* Budget exhausted: log once per tick, retry when the window rolls. */
      log(`deferring cycle: daily LLM budget spent (${used}/${state.settings.maxLlmCyclesPerDay} in 24h)`);
      return;
    }
    const busy = machineBusy();
    if (busy) {
      log(`deferring cycle: ${busy}`);
      return;
    }
    /* Cross-process cycle lock: the startedAt/in-flight defer above only sees
       runs that reached state.json; two processes ticking in the same second
       (the restart stampede) both pass it. The file lock is the durable gate —
       exactly one process wins the atomic create. "held" defers to the holder
       (next tick retries); "unlocked" means the filesystem failed and we fail
       open rather than stall the swarm; stale orphans are taken over inside. */
    const lock = await acquireCycleLock();
    if (lock === "held") {
      log("deferring cycle: another process holds the cycle lock");
      return;
    }
    if (lock === "unlocked") log("cycle lock unavailable (fs error); proceeding without it");
    try {
      log(triggerEvent ? `starting event-driven cycle (${triggerEvent})` : "starting scheduled cycle");
      const run = await runCycle(triggerEvent ? "event" : "scheduler");
      s.lastCycleAt = Date.now();
      s.lastGradeDate = today;
      log(
        `cycle ${run.id} finished: ${run.draftsCreated} drafts, ${run.proposalsCreated} proposals${run.error ? `, error: ${run.error}` : ""}`,
      );
      /* Fresh cycle output should reach the public viewer immediately. */
      void maybePublishSnapshot({ force: true });
    } finally {
      if (lock === "acquired") {
        await releaseCycleLock();
        log("cycle lock released");
      }
    }
    return;
  }

  if (!hasGradeToday && s.lastGradeDate !== today) {
    log("stamping daily grade");
    const grade = await runGrader();
    s.lastGradeDate = today;
    log(`grade ${grade.date}: ${grade.letter} ${grade.score.toFixed(1)}`);
    return;
  }

  /* Quiet-path heartbeat: one line per tick proves the loop is alive without
     needing HTTP traffic. When this line stops, the host froze (see the
     suspend note in startScheduler) — the loop itself has no other way to die
     silently. Busy paths above (cycle, defers) log their own lines instead. */
  const minsToNext = Math.max(0, Math.ceil((intervalMs - sinceLastCycle) / 60_000));
  log(`tick · next cycle in ~${minsToNext}m · budget ${used}/${state.settings.maxLlmCyclesPerDay} in 24h`);
}

export function startScheduler(options: { firstTickDelayMs?: number } = {}): void {
  if (globalThis.__lauraScheduler?.started) return;
  globalThis.__lauraScheduler = { started: true, lastCycleAt: 0, lastGradeDate: "" };
  log("autopilot online");
  const loop = async () => {
    let lastLoopEndedAt = 0;
    for (;;) {
      /* Host-suspend detection. This deployment's VM is paused by its
         hypervisor when unattended (kernel logs "crng reseeded due to virtual
         machine fork" on resume; observed 02:17→07:41 UTC freeze on
         2026-09-10). While frozen NOTHING in the guest runs — timers, HTTP,
         even a keepalive curl loop — so no in-process fix can tick through it.
         What we can do: name the gap on resume so it reads as a suspension,
         not a scheduler death, and let the first tick catch up (cycle cadence
         is wall-clock anchored, so an overdue cycle fires immediately). */
      if (lastLoopEndedAt > 0) {
        const gapMs = Date.now() - lastLoopEndedAt;
        if (gapMs > 5 * TICK_MS) {
          log(`resumed after ${(gapMs / 60_000).toFixed(1)} min without ticks (host suspended); catching up`);
        }
      }
      try {
        await tick();
      } catch (err) {
        log(`tick failed: ${String(err)}`);
      }
      lastLoopEndedAt = Date.now();
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  };
  setTimeout(() => void loop(), options.firstTickDelayMs ?? 0);
}
