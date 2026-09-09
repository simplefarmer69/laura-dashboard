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
  const { startBots } = await import("@/lib/chat/bots");
  startBots();
  if (process.env.SWARM_AUTOPILOT === "0") return;
  const { startScheduler } = await import("@/lib/swarm/scheduler");
  startScheduler({ firstTickDelayMs: 15_000 });
}
