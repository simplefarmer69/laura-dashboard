import { runCycle } from "@/lib/swarm/orchestrator";

/** One-shot cycle for cron or manual use: `npm run cycle`. */
async function main(): Promise<void> {
  const run = await runCycle("scheduler");
  for (const s of run.steps) {
    console.log(`${s.status.padEnd(7)} ${s.agentId.padEnd(8)} ${s.label}: ${s.summary}`);
  }
  console.log(
    `${run.draftsCreated} drafts, ${run.proposalsCreated} proposals${run.error ? `, error: ${run.error}` : ""}`,
  );
  process.exit(run.error ? 1 : 0);
}

void main();
