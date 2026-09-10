import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Cheap corruption insurance for the single-file hot stores: every
 * BACKUP_INTERVAL_MS (checked on each state save, so no timer needed) copy
 * state.json and notebook.json into data/backups/ with a timestamped name,
 * keeping the newest KEEP copies of each. A bad write or a wiped state.json
 * is then a one-file restore instead of a total memory loss — the SQLite
 * archive still holds the full append-only history either way.
 */

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_INTERVAL_MS = 6 * 3_600_000;
const KEEP = 14;
const SOURCES = ["state.json", "notebook.json"] as const;

/* One in-flight/last-run marker per process; survives Next dev HMR. */
declare global {
  var __lauraBackupLastAt: number | undefined;
}

async function newestBackupAt(): Promise<number> {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    let newest = 0;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const st = await fs.stat(path.join(BACKUP_DIR, f));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
    return newest;
  } catch {
    return 0;
  }
}

async function prune(prefix: string): Promise<void> {
  const files = (await fs.readdir(BACKUP_DIR)).filter((f) => f.startsWith(prefix)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    await fs.rm(path.join(BACKUP_DIR, f), { force: true });
  }
}

/** Backs up the hot JSON files when the newest backup is older than the interval. Never throws. */
export async function maybeBackup(): Promise<void> {
  try {
    const now = Date.now();
    /* In-memory gate first (cheap), then the on-disk truth (survives restarts). */
    if (globalThis.__lauraBackupLastAt && now - globalThis.__lauraBackupLastAt < BACKUP_INTERVAL_MS) return;
    const newest = await newestBackupAt();
    if (now - newest < BACKUP_INTERVAL_MS) {
      globalThis.__lauraBackupLastAt = newest;
      return;
    }
    globalThis.__lauraBackupLastAt = now;
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date(now).toISOString().replaceAll(":", "-").slice(0, 19);
    for (const src of SOURCES) {
      const from = path.join(DATA_DIR, src);
      const base = src.replace(/\.json$/, "");
      try {
        await fs.copyFile(from, path.join(BACKUP_DIR, `${base}-${stamp}.json`));
        await prune(`${base}-`);
      } catch {
        /* source may not exist yet (fresh install); skip silently */
      }
    }
    console.log(`[laura backup] snapshotted ${SOURCES.join(" + ")} at ${stamp}`);
  } catch (err) {
    console.error(`[laura backup] failed: ${String(err)}`);
  }
}
