/**
 * Next.js instrumentation hook: runs once per server process. Starts LAURA's
 * autopilot inside the console so a single `npm run dev` / `npm start` keeps the
 * swarm cycling and grading daily. Set SWARM_AUTOPILOT=0 to disable (for example
 * when running scripts/worker.ts as a separate process).
 *
 * The scheduler is imported dynamically on purpose: this file is bundled for
 * every runtime and the scheduler pulls in node:fs, which must not reach the
 * edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  /* Public viewer deployment: a passive renderer of published snapshots.
     No bots, no scheduler, no executor — nothing that acts or spends. */
  if (process.env.VIEWER_MODE === "1" || process.env.NEXT_PUBLIC_VIEWER_MODE === "1") {
    console.log("[laura] viewer mode: bots and autopilot stay off — read-only deployment");
    return;
  }
  const { startBots } = await import("@/lib/chat/bots");
  startBots();
  await installGracefulShutdown();
  if (process.env.SWARM_AUTOPILOT === "0") return;
  const { startScheduler } = await import("@/lib/swarm/scheduler");
  startScheduler({ firstTickDelayMs: 15_000 });
}

declare global {
  var __lauraShutdownInstalled: boolean | undefined;
}

/** Upper bound on how long a reload waits for a deploy/arm/buy to finish its bookkeeping. */
const SHUTDOWN_CHAIN_WAIT_MS = 120_000;

/**
 * With NEXT_MANUAL_SIG_HANDLE=true (set by ecosystem.config.cjs) Next leaves
 * SIGTERM/SIGINT to us. A PM2 reload then waits — up to `kill_timeout` — for
 * any chain work in flight to record itself before the process exits, instead
 * of dropping a mined createLaunch on the floor mid-deploy ($GRADED, 2026-09-11).
 * Without the env flag Next exits immediately on its own and this is a no-op.
 */
async function installGracefulShutdown(): Promise<void> {
  if (process.env.NEXT_MANUAL_SIG_HANDLE !== "true") return;
  if (globalThis.__lauraShutdownInstalled) return;
  globalThis.__lauraShutdownInstalled = true;
  const { awaitChainWorkQuiet, chainWorkInFlight } = await import("@/lib/chain-work");
  let exiting = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (exiting) return;
    exiting = true;
    const open = chainWorkInFlight();
    if (open.length === 0) {
      console.log(`[laura] ${signal}: nothing in flight — exiting`);
      process.exit(0);
    }
    console.log(`[laura] ${signal}: waiting for chain work to finish before exit: ${open.join(", ")}`);
    void awaitChainWorkQuiet(SHUTDOWN_CHAIN_WAIT_MS).then(({ quiet, waitedMs }) => {
      if (quiet) console.log(`[laura] chain work finished after ${Math.round(waitedMs / 1000)}s — exiting`);
      else console.warn(`[laura] chain work still open after ${Math.round(waitedMs / 1000)}s (${chainWorkInFlight().join(", ")}); exiting — the executor reconciles on the next tick`);
      process.exit(0);
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
