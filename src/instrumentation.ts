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
  if (process.env.LAURA_DAEMON === "1") await makeEnvFileAuthoritative();
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

/**
 * Under the PM2 daemon, shared/.env.local is the documented source of truth
 * for secrets. Next only fills variables the process did NOT inherit, and PM2
 * pins whatever shell environment was present when the app was first started
 * — on 2026-09-12 that inherited environment held older X_API_KEY and
 * ANTHROPIC_API_KEY values, so key rotations written to the file never reached
 * the running daemon. Here the file wins for every key it defines with a
 * non-empty value; only key names are logged, never values.
 */
async function makeEnvFileAuthoritative(): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const file = path.join(process.cwd(), ".env.local");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return;
  }
  const overridden: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!value) continue;
    if (process.env[m[1]] !== value) {
      if (process.env[m[1]] !== undefined) overridden.push(m[1]);
      process.env[m[1]] = value;
    }
  }
  if (overridden.length) console.log(`[laura] env: .env.local is authoritative under the daemon; replaced inherited ${overridden.join(", ")}`);
}
