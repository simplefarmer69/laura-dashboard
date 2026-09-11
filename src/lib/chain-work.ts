/**
 * Registry of chain work in flight in this process: a launch deploy, an arm,
 * a treasury buy, an LP mint, a fee claim. Anything that has sent (or is
 * about to send) a transaction and still has bookkeeping to do.
 *
 * Why it exists: on 2026-09-11 the daemon's updater switched releases while
 * the executor was 12 seconds into deploying $GRADED. /api/health said
 * `busy:false` (it only knew about cycles and Cafe Bar rounds), PM2 reloaded
 * the app, the createLaunch tx was mined, and the process that would have
 * recorded, armed and branded the token was gone. The record sat in
 * "deploying" with no address. Three rails now hang off this registry:
 *   1. /api/health reports `busy` while any entry is open, so the updater
 *      waits (it already polls for a quiet moment);
 *   2. the process's SIGTERM/SIGINT handler waits for open entries before
 *      exiting, so a reload that does land mid-work still lets it finish;
 *   3. the executor reconciles any launch left in "deploying" against the pad
 *      on the next tick, so even a hard kill self-heals.
 *
 * Lives on globalThis so dev HMR module copies share one registry.
 */

declare global {
  var __lauraChainWork: Map<string, { label: string; since: number }> | undefined;
}

function registry(): Map<string, { label: string; since: number }> {
  return (globalThis.__lauraChainWork ??= new Map());
}

let seq = 0;

/** Marks chain work open; call the returned function when it is fully recorded. */
export function beginChainWork(label: string): () => void {
  const key = `${label}#${++seq}`;
  registry().set(key, { label, since: Date.now() });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    registry().delete(key);
  };
}

/** Labels of every open unit of chain work, oldest first. */
export function chainWorkInFlight(): string[] {
  return [...registry().values()].sort((a, b) => a.since - b.since).map((w) => w.label);
}

/** True while a specific label (e.g. `launch:launch_ab12`) is open. */
export function chainWorkOpen(label: string): boolean {
  for (const w of registry().values()) if (w.label === label) return true;
  return false;
}

/**
 * Resolves when no chain work is open, or after `maxWaitMs`. Used by the
 * shutdown handler; polls because the registry is a plain Map by design.
 */
export async function awaitChainWorkQuiet(maxWaitMs: number): Promise<{ quiet: boolean; waitedMs: number }> {
  const started = Date.now();
  while (registry().size > 0) {
    if (Date.now() - started >= maxWaitMs) return { quiet: false, waitedMs: Date.now() - started };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { quiet: true, waitedMs: Date.now() - started };
}
