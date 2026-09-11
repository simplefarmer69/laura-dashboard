import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Cross-process cycle lock. After a mid-cycle dev-server restart, two Next.js
 * processes can each run a scheduler loop; the in-process `cycleInFlight`
 * guard in the orchestrator cannot see across processes. This file-based lock
 * (data/cycle.lock, sibling of state.json) makes cycle execution exclusive:
 * acquisition is an atomic O_EXCL create, so exactly one process wins.
 *
 * Failure posture, in order of importance:
 * - Never deadlock: a lock older than CYCLE_LOCK_STALE_MS, or whose holder pid
 *   is no longer running, is treated as orphaned (crashed process) and taken
 *   over; a corrupt/unreadable lock file counts as stale.
 * - Never stop the swarm: unexpected filesystem errors fail OPEN ("unlocked")
 *   — the caller proceeds without the lock rather than stalling forever.
 * - Never release someone else's lock: release only unlinks when the recorded
 *   pid is ours, so a process whose stale lock was taken over cannot delete
 *   the new holder's lock on its way out.
 */

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const LOCK_FILE = path.join(DATA_DIR, "cycle.lock");

/** Locks older than this are orphans; comfortably above the slowest observed cycle. */
export const CYCLE_LOCK_STALE_MS = 30 * 60_000;

export type CycleLockResult = "acquired" | "held" | "unlocked";

interface LockPayload {
  pid: number;
  startedAt: number;
}

/**
 * A holder that no longer exists cannot finish its cycle. Every runtime that
 * shares this data dir runs on the same machine, so `kill -0` is authoritative;
 * EPERM (alive but not ours) counts as alive. Lets a PM2/daemon restart
 * mid-cycle resume within a minute instead of idling out the stale window.
 */
function holderAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomic create; false when the file already exists. */
async function writeLock(now: number): Promise<boolean> {
  const payload: LockPayload = { pid: process.pid, startedAt: now };
  try {
    await fs.writeFile(LOCK_FILE, JSON.stringify(payload), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export async function acquireCycleLock(now = Date.now()): Promise<CycleLockResult> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    if (await writeLock(now)) return "acquired";
    /* Lock exists — respect it while fresh. */
    let stale = true;
    try {
      const held = JSON.parse(await fs.readFile(LOCK_FILE, "utf8")) as Partial<LockPayload>;
      const fresh = typeof held.startedAt === "number" && now - held.startedAt < CYCLE_LOCK_STALE_MS;
      stale = !fresh || !holderAlive(held.pid);
    } catch {
      /* unreadable or corrupt lock: treat as stale */
    }
    if (!stale) return "held";
    /* Stale takeover: remove the orphan and race for a fresh lock; losing the
       race just means another process took over first — defer to it. */
    await fs.unlink(LOCK_FILE).catch(() => {});
    return (await writeLock(now)) ? "acquired" : "held";
  } catch {
    return "unlocked";
  }
}

export async function releaseCycleLock(): Promise<void> {
  try {
    const held = JSON.parse(await fs.readFile(LOCK_FILE, "utf8")) as Partial<LockPayload>;
    if (held.pid === process.pid) await fs.unlink(LOCK_FILE);
  } catch {
    /* already gone or unreadable — nothing of ours to release */
  }
}
