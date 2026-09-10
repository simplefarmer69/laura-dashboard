/**
 * One-shot migration: seed the SQLite archive from the current hot stores
 * (data/state.json + data/notebook.json) so history that predates the archive
 * is preserved. Safe to re-run — upserts are idempotent. After this, every
 * saveState() keeps the archive current automatically.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/archive-backfill.ts
 */
import { loadState } from "@/lib/store";
import { archiveNotebookEntries, archiveState, archiveStats } from "@/lib/swarm/archive";
import { loadNotebook } from "@/lib/swarm/notebook";

async function main(): Promise<void> {
  const state = await loadState();
  archiveState(state);
  const notebook = await loadNotebook();
  archiveNotebookEntries(notebook);
  const stats = archiveStats();
  console.log("archive backfill complete:");
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
