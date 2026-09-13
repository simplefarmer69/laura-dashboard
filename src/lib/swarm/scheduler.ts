import os from "node:os";
import { loadState, pushEvent, updateState } from "@/lib/store";
import { acquireCycleLock, releaseCycleLock } from "@/lib/swarm/cycle-lock";
import { hasPendingApprovals, sweepPendingApprovals } from "@/lib/swarm/autonomy";
import { isCycleRunning, runCycle, runGrader } from "@/lib/swarm/orchestrator";
import { forumRoundStartedAt, isForumRoundRunning, lastForumPostAt, runForumRound } from "@/lib/swarm/forum";
import { runLaunchExecutor } from "@/lib/launchpad/executor";
import { runEarningsMaintenance } from "@/lib/launchpad/earnings";
import { runTreasuryTick } from "@/lib/launchpad/treasury";
import { runSmartLpTick } from "@/lib/launchpad/smart-lp";
import { runBuilderTick } from "@/lib/builder/executor";
import { runXPublishTick } from "@/lib/publish/auto";
import { runXMentionsTick } from "@/lib/publish/mentions";
import { runXPeopleTick } from "@/lib/publish/x-people";
import { refreshXPostMetrics } from "@/lib/publish/x-metrics";
import { maybePublishSnapshot, startLivePublishing } from "@/lib/viewer/publish";
import { utcDate } from "@/lib/grader/score";
import { clearFlag, flagPending, RESTART_FLAG } from "@/lib/ops";
import { beginChainWork, chainWorkInFlight } from "@/lib/chain-work";
import type { SwarmEventKind, SwarmState } from "@/lib/types";

async function withChainWork<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const done = beginChainWork(label);
  try {
    return await fn();
  } finally {
    done();
  }
}

/**
 * LAURA's autopilot. Cascade design: the per-minute tick does only cost-free
 * checks (launch queue, budget, capacity, trigger events); LLM cycles run
 * around the clock: `cycleIntervalMinutes` (read live from settings) is the
 * REST GAP between the end of one cycle and the start of the next, not a
 * wall-clock period — operator directive 2026-09-11: "LAURA should run around
 * the clock improving all the time, calling keys as needed", replacing the
 * old 75-minute pause that left the swarm idle ~75% of the day. Event-driven
 * cycles (a launch goes live, a milestone hits) can still cut a longer gap
 * short. A hard rolling-24h budget (`maxLlmCyclesPerDay`) bounds API cost
 * whatever the gap and triggers do. The grader is stamped every UTC day even
 * if no cycle landed on it. Safe to call more than once per process: only the
 * first call starts the loop.
 */
const TICK_MS = 60_000;
const DAY_MS = 86_400_000;

/** Minimum gap between cycles even when trigger events fire back-to-back. */
const MIN_EVENT_GAP_MS = 20 * 60_000;

/**
 * The Cafe Bar (agent forum) ran only when someone pressed the console button
 * — it went quiet for hours whenever nobody did (operator report 2026-09-11:
 * "some parts of the process seem stuck"). The autopilot now opens a round
 * whenever the venue has been silent this long, in the slot where the next
 * cycle would start, so rounds and cycles never write the state concurrently.
 * A round is ~19 LLM calls (one per agent plus the host), so at ~16 min per
 * round this adds roughly one round per two cycles.
 */
const FORUM_QUIET_MS = 60 * 60_000;

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
  /* Legacy guard read by scheduler loops started before the 2026-09-10 store
     fix. Kept declared so this module can clear it: the old loop's tick
     no-ops when it is undefined, which retires that loop without a server
     restart (its module snapshot predates the current roster and the
     rebase-on-save store, so its saves must stop). */
  var __lauraScheduler: { started: boolean; lastCycleAt: number; lastGradeDate: string } | undefined;
  var __lauraSchedulerV2: { started: boolean; lastCycleAt: number; lastGradeDate: string } | undefined;
}

function log(msg: string): void {
  console.log(`[laura ${new Date().toISOString()}] ${msg}`);
}

export function schedulerRunning(): boolean {
  return globalThis.__lauraSchedulerV2?.started ?? false;
}

/**
 * What LAURA is doing right now, for the console header and the public
 * banner. The viewer used to infer "resting" from snapshot age alone, which
 * read as "LAURA is asleep" during a 20-minute cycle (operator report
 * 2026-09-11: "confusing people"). This is the truthful signal instead:
 * cycle or Cafe Bar round in flight, the countdown to the next cycle in the
 * rest gap, or the one reason the loop is paused (budget spent / autopilot
 * off). Maintenance ticks (launch queue, treasury, X rail) keep running in
 * every phase but "off".
 */
export interface RuntimeActivity {
  phase: "cycle" | "forum" | "between" | "paused" | "off";
  /** When the current phase began (cycle/round start, or the last cycle's end). */
  since: number | null;
  /** Expected start of the next cycle; only in "between" and "paused". */
  nextCycleAt: number | null;
  /** Id of the run in flight (phase "cycle"). */
  runId: string | null;
  /** Rolling-24h LLM cycle budget. */
  budgetUsed: number;
  budgetMax: number;
  /** One-line reason for "paused"/"off"; null otherwise. */
  note: string | null;
}

export function runtimeActivity(state: SwarmState, now = Date.now()): RuntimeActivity {
  const budgetUsed = cyclesInLast24h(state, now);
  const budgetMax = state.settings.maxLlmCyclesPerDay;
  const base = { budgetUsed, budgetMax, runId: null, nextCycleAt: null, note: null };
  const latestRun = state.runs.at(-1);
  if (isCycleRunning()) {
    const open = latestRun && !latestRun.finishedAt ? latestRun : null;
    return { ...base, phase: "cycle", since: open?.startedAt ?? now, runId: open?.id ?? null };
  }
  if (isForumRoundRunning()) {
    return { ...base, phase: "forum", since: forumRoundStartedAt() ?? now };
  }
  const s = globalThis.__lauraSchedulerV2;
  if (!s?.started) {
    return { ...base, phase: "off", since: null, note: "autopilot is not running in this process" };
  }
  const lastCycleAt = Math.max(s.lastCycleAt, latestRun?.finishedAt ?? latestRun?.startedAt ?? 0);
  const intervalMs = Math.max(1, state.settings.cycleIntervalMinutes) * 60_000;
  if (budgetUsed >= budgetMax) {
    /* Window rolls when the oldest counted run leaves the 24h span. */
    const oldest = state.runs
      .filter((r) => r.startedAt > now - DAY_MS)
      .reduce((min, r) => Math.min(min, r.startedAt), now);
    return {
      ...base,
      phase: "paused",
      since: lastCycleAt || null,
      nextCycleAt: oldest + DAY_MS,
      note: `daily LLM budget spent (${budgetUsed}/${budgetMax}); maintenance ticks continue`,
    };
  }
  return {
    ...base,
    phase: "between",
    since: lastCycleAt || null,
    nextCycleAt: Math.max(now, lastCycleAt + intervalMs),
  };
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
  const s = globalThis.__lauraSchedulerV2;
  if (!s) return;
  /* Public-viewer feed: push a sanitized snapshot on a ~5-min cadence (the
     guard lives inside; non-fatal on failure, no-op until configured). */
  void maybePublishSnapshot();
  const state = await loadState();
  /* Floor of one minute (one tick): the gap exists so the finished cycle's
     state save, snapshot publish and lock release settle before the next run
     opens — not to ration work. Rationing is the 24h budget's job. */
  const intervalMs = Math.max(1, state.settings.cycleIntervalMinutes) * 60_000;
  /* Anchor cadence to the latest run's activity, not only to finished runs:
     a run orphaned by a dev-server restart never gets finishedAt, and anchoring
     on 0 would make every fresh process fire a cycle immediately (and treat
     ancient events as fresh triggers). */
  const latestRun = state.runs.at(-1);
  if (latestRun) s.lastCycleAt = Math.max(s.lastCycleAt, latestRun.finishedAt ?? latestRun.startedAt);

  /* Self-heal: a process death or host suspension mid-cycle leaves runs
     permanently unfinished and agents shown as "running" forever (made the
     swarm look stalled on 2026-09-10, and again after the 02:27-07:17 UTC
     suspension on 2026-09-11 — that orphan was no longer the NEWEST run by
     the time anyone looked, so the sweep covers every stale run, not just
     the latest). 45 min is double the longest observed cycle, and
     isCycleRunning() covers every in-process cycle whatever its trigger, so
     a live cycle is never clipped. Agents reset only when no cycle is in
     flight for the same reason. */
  const staleIds = state.runs
    .filter((r) => !r.finishedAt && Date.now() - r.startedAt > 45 * 60_000)
    .map((r) => r.id);
  if (staleIds.length > 0 && !isCycleRunning()) {
    await updateState((st) => {
      for (const id of staleIds) {
        const orphan = st.runs.find((r) => r.id === id);
        if (!orphan || orphan.finishedAt) continue;
        orphan.finishedAt = Date.now();
        orphan.error = orphan.error ?? "orphaned: process died or host suspended mid-cycle; finalized by scheduler self-heal";
        pushEvent(st, {
          kind: "cycle.finished",
          agentId: "system",
          title: `Cycle ${orphan.id} finalized by self-heal (orphaned mid-cycle)`,
          detail: "The process running this cycle stopped before it finished; the record is closed so nothing waits on it.",
          refId: orphan.id,
        });
      }
      for (const a of st.agents) if (a.status === "running") a.status = "idle";
    });
    log(`self-heal: finalized orphaned run(s) ${staleIds.join(", ")}`);
  }

  /* Operator-requested graceful restart (daemon hosts only): exit at a tick
     with nothing in flight and let PM2/Railway bring the process back on the
     freshly switched release. The flag is cleared first so a crash loop can
     never be induced by a stale file. */
  if (
    process.env.LAURA_DAEMON === "1" &&
    !isCycleRunning() &&
    !isForumRoundRunning() &&
    chainWorkInFlight().length === 0 &&
    (await flagPending(RESTART_FLAG))
  ) {
    await clearFlag(RESTART_FLAG);
    log("restart requested by operator; quiet tick — exiting for the process manager to restart");
    setTimeout(() => process.exit(0), 500);
    return;
  }

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

  /* The wallet-touching ticks below run under a chain-work mark so
     /api/health reports busy and a reload waits until their bookkeeping is
     written (the $GRADED incident: a release switch 12 s into a deploy). */

  /* Earnings watch: cheap on-chain snapshot every ~10 min (interval guard and
     error handling live inside; never throws). Claims send only when
     settings.autoClaimEarnings is true. */
  await withChainWork("earnings", () => runEarningsMaintenance(state));

  /* Treasury ops: capped $STONKBROKER accumulation buys (mission-token only).
     All gates live inside (TREASURY_CAPS, floor, executor-busy skip); the
     pure-math eligibility pre-check makes idle ticks free. Never throws. */
  await withChainWork("treasury", () => runTreasuryTick(state));

  /* Smart LP (Stonk Exchange vDEX): pairs accumulated STONK with ETH into one
     full-range position, stakes it for $UP, and refreshes position values.
     Same fail-closed caps/floor/executor-skip discipline. Never throws. */
  await withChainWork("smart-lp", () => runSmartLpTick(state));

  /* Utility builder ops: ships approved dashboard builds every tick; chain
     actions (bag buys, template deploys) additionally require the operator's
     autoExecuteUtility flag and stay inside BUILDER_CAPS. Never throws. */
  await withChainWork("builder", () => runBuilderTick(state));

  /* Outbound: fresh approved X drafts post themselves inside the x-guard
     caps (one per tick); silent no-op until the access keys exist. */
  try {
    await runXPublishTick(state);
  } catch (err) {
    log(`x auto-publish tick failed: ${String(err)}`);
  }

  /* Inbound: people who tag @LAURA_DAIO with a question get one answer,
     inside the mentions rail's own caps. Polls every 10 minutes. */
  try {
    await runXMentionsTick(state);
  } catch (err) {
    log(`x mentions tick failed: ${String(err)}`);
  }

  /* Robinhood people: discover staff by their own public bios (6h stride)
     and follow them from the account, one per 90 s, 25 per day. */
  try {
    await runXPeopleTick(state);
  } catch (err) {
    log(`x people tick failed: ${String(err)}`);
  }

  /* Read-back: engagement counters for the account's own recent posts
     (bearer, one request every ~2h). Feeds the voice study. Never throws. */
  await refreshXPostMetrics();

  /* Daily grade first: with back-to-back cycles the "nothing due" branch
     below may never be reached, so the stamp must not depend on it. One
     tick's delay for the next cycle is the whole cost. */
  if (!hasGradeToday && s.lastGradeDate !== today) {
    log("stamping daily grade");
    const grade = await runGrader();
    s.lastGradeDate = today;
    log(`grade ${grade.date}: ${grade.letter} ${grade.score.toFixed(1)}`);
    return;
  }

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
      /* Bar first when it has gone quiet: the round takes the cycle's slot and
         the cycle follows after the normal rest gap (the round stamps
         lastCycleAt). Rounds are not counted in the cycle budget; the quiet
         window bounds them to at most one per hour on its own. */
      if (Date.now() - lastForumPostAt(state) > FORUM_QUIET_MS && !isForumRoundRunning()) {
        log("Cafe Bar quiet for over an hour; opening a forum round before the next cycle");
        const stopLive = startLivePublishing();
        let round: Awaited<ReturnType<typeof runForumRound>>;
        try {
          round = await runForumRound();
        } finally {
          stopLive();
        }
        s.lastCycleAt = Date.now();
        log(
          `forum round ${round.roundId} done: ${round.threadsOpened} thread(s), ${round.postsWritten} post(s), ${round.llmCalls} LLM call(s)${round.notes.length ? `, notes: ${round.notes.slice(0, 2).join("; ")}` : ""}`,
        );
        void maybePublishSnapshot({ force: true });
        return;
      }
      log(triggerEvent ? `starting event-driven cycle (${triggerEvent})` : "starting scheduled cycle");
      const stopLive = startLivePublishing();
      let run: Awaited<ReturnType<typeof runCycle>>;
      try {
        run = await runCycle(triggerEvent ? "event" : "scheduler");
      } finally {
        stopLive();
      }
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

  /* Quiet-path heartbeat: one line per tick proves the loop is alive without
     needing HTTP traffic. When this line stops, the host froze (see the
     suspend note in startScheduler) — the loop itself has no other way to die
     silently. Busy paths above (cycle, defers) log their own lines instead. */
  const minsToNext = Math.max(0, Math.ceil((intervalMs - sinceLastCycle) / 60_000));
  log(`tick · next cycle in ~${minsToNext}m · budget ${used}/${state.settings.maxLlmCyclesPerDay} in 24h`);
}

export function startScheduler(options: { firstTickDelayMs?: number } = {}): void {
  if (globalThis.__lauraSchedulerV2?.started) return;
  /* Retire any pre-V2 loop from an older module snapshot: its tick checks
     this guard on every pass and no-ops once it is gone. Required after the
     store fix, because that loop saves through a stale roster and a
     non-merging store until the process restarts. */
  if (globalThis.__lauraScheduler) {
    globalThis.__lauraScheduler = undefined;
    log("legacy autopilot loop retired (stale module snapshot); V2 taking over");
  }
  globalThis.__lauraSchedulerV2 = { started: true, lastCycleAt: 0, lastGradeDate: "" };
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
