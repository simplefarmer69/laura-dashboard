import assert from "node:assert/strict";
import { loadState, newId, pushEvent, saveState, updateState } from "@/lib/store";
import type { CycleRun, Draft, ForumThread, LaunchProposal } from "@/lib/types";

/**
 * Concurrency proof for the rebase-on-save store. Reproduces the exact
 * last-writer-wins clobber observed on 2026-09-10 (a forum round's stale
 * snapshot saved after a cycle finalized, rolling back the run record and a
 * Sage draft) and asserts both writers now survive.
 *
 * Run ONLY against a throwaway data dir:
 *   SWARM_DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json scripts/store-race-test.ts
 */

const dataDir = process.env.SWARM_DATA_DIR ?? "";
if (!dataDir || dataDir.includes("/workspace/data") || !dataDir.startsWith("/tmp")) {
  console.error("Refusing to run: set SWARM_DATA_DIR to a throwaway directory under /tmp.");
  process.exit(1);
}

function makeRun(trigger: CycleRun["trigger"]): CycleRun {
  return {
    id: newId("run"),
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    steps: [],
    draftsCreated: 0,
    proposalsCreated: 0,
    llmProvider: "mock",
    error: null,
  };
}

function makeDraft(cycleId: string): Draft {
  return {
    id: newId("draft"),
    cycleId,
    agentId: "sage",
    kind: "research",
    channel: "Library",
    title: "Race test memo",
    body: "Body",
    rationale: "Rationale",
    status: "approved",
    createdAt: Date.now(),
    reviewedAt: Date.now(),
    reviewerNote: null,
  };
}

function makeThread(roundId: string): ForumThread {
  const thread: ForumThread = {
    id: newId("thread"),
    title: "Race test thread",
    tag: "ops",
    createdBy: "scout",
    createdAt: Date.now(),
    status: "open",
    posts: [],
  };
  thread.posts.push({
    id: newId("post"),
    threadId: thread.id,
    agentId: "scout",
    ts: Date.now(),
    roundId,
    body: "Race test opener",
  });
  return thread;
}

function makeLaunch(): LaunchProposal {
  return {
    id: newId("launch"),
    cycleId: "run_seed",
    createdAt: Date.now(),
    lane: "weth",
    name: "Race Test",
    symbol: "RACE",
    supplyTokens: 1_000_000,
    startMcapUsd: 5000,
    gradMcapUsd: 25000,
    startTaxBps: 500,
    taxDecayPerMinuteBps: 10,
    postTaxBps: 100,
    sellsEnabled: true,
    bufferSecs: 60,
    concept: "Concept",
    rationale: "Rationale",
    status: "approved",
    reviewedAt: Date.now(),
    reviewerNote: null,
    txHash: null,
    tokenAddress: null,
    launchId: null,
    deployedAt: null,
    error: null,
    imageHash: null,
  };
}

async function main(): Promise<void> {
  /* Seed: one launch waiting for the executor, baseline sage stats. */
  await updateState((s) => {
    s.launches.push(makeLaunch());
    const sage = s.agents.find((a) => a.id === "sage")!;
    sage.stats.drafts = 5;
    sage.stats.runs = 3;
  });

  /* ---- Scenario 1: the observed clobber, forum round vs cycle ---------- */
  /* The "forum round" loads first and holds its snapshot. */
  const forumState = await loadState();
  const roundId = newId("fround");

  /* The "cycle" loads later, does its work, finalizes, saves. */
  const cycleState = await loadState();
  const run = makeRun("manual");
  cycleState.runs.push(run);
  const sageDraft = makeDraft(run.id);
  cycleState.drafts.push(sageDraft);
  const cycleSage = cycleState.agents.find((a) => a.id === "sage")!;
  cycleSage.stats.drafts += 1;
  cycleSage.stats.runs += 1;
  run.draftsCreated = 1;
  run.finishedAt = Date.now();
  pushEvent(cycleState, {
    kind: "cycle.finished",
    agentId: "system",
    title: `Cycle ${run.id} finished`,
    detail: "1 draft",
    refId: run.id,
  });
  await saveState(cycleState);

  /* Meanwhile the executor deploys the launch through updateState. */
  const deployed = await updateState((s) => {
    const l = s.launches.find((x) => x.symbol === "RACE")!;
    l.status = "deployed";
    l.txHash = "0xtest";
    l.deployedAt = Date.now();
    return l.id;
  });

  /* The forum round now saves its STALE snapshot (loaded before all of the
     above). Pre-fix this rolled back the run, the draft, the stats and the
     deploy. */
  forumState.forum = forumState.forum ?? [];
  const thread = makeThread(roundId);
  forumState.forum.push(thread);
  pushEvent(forumState, {
    kind: "forum.thread",
    agentId: "scout",
    title: "Race test thread opened",
    detail: "opener",
    refId: thread.id,
  });
  await saveState(forumState);

  const after = await loadState();
  const runAfter = after.runs.find((r) => r.id === run.id);
  assert.ok(runAfter, "cycle run survives the stale forum save");
  assert.ok(runAfter.finishedAt !== null, "run stays finalized (finishedAt survives)");
  assert.equal(runAfter.draftsCreated, 1, "run counters survive");
  assert.ok(after.drafts.some((d) => d.id === sageDraft.id), "sage draft survives");
  const sageAfter = after.agents.find((a) => a.id === "sage")!;
  assert.equal(sageAfter.stats.drafts, 6, "sage draft counter survives");
  assert.equal(sageAfter.stats.runs, 4, "sage run counter survives");
  assert.ok(
    after.events.some((e) => e.kind === "cycle.finished" && e.refId === run.id),
    "cycle.finished event survives",
  );
  const launchAfter = after.launches.find((l) => l.id === deployed)!;
  assert.equal(launchAfter.status, "deployed", "executor's launch status update survives");
  assert.equal(launchAfter.txHash, "0xtest", "executor's tx fields survive");
  const threadAfter = (after.forum ?? []).find((t) => t.id === thread.id);
  assert.ok(threadAfter, "forum thread from the stale writer also lands");
  assert.equal(threadAfter.posts.length, 1, "forum post lands");
  console.log("scenario 1 ok: stale forum save no longer rolls back the cycle, and its own posts land");

  /* ---- Scenario 2: interleaved multi-save long flows ------------------- */
  const flowA = await loadState();
  const flowB = await loadState();
  const runA = makeRun("scheduler");
  flowA.runs.push(runA);
  await saveState(flowA);
  const threadB = makeThread(newId("fround"));
  flowB.forum = flowB.forum ?? [];
  flowB.forum.push(threadB);
  await saveState(flowB);
  /* A keeps mutating its old snapshot across more saves. */
  runA.steps.push({ agentId: "system", label: "step", status: "ok", summary: "s1", durationMs: 1 });
  await saveState(flowA);
  /* B appends a post to its thread and saves again. */
  threadB.posts.push({
    id: newId("post"),
    threadId: threadB.id,
    agentId: "coach",
    ts: Date.now(),
    roundId: threadB.posts[0].roundId,
    body: "second post",
  });
  await saveState(flowB);
  runA.finishedAt = Date.now();
  await saveState(flowA);

  const after2 = await loadState();
  const runA2 = after2.runs.find((r) => r.id === runA.id)!;
  assert.ok(runA2.finishedAt !== null, "flow A finalization survives interleaved saves");
  assert.equal(runA2.steps.length, 1, "flow A steps survive");
  const threadB2 = (after2.forum ?? []).find((t) => t.id === threadB.id)!;
  assert.equal(threadB2.posts.length, 2, "flow B posts all survive interleaved saves");
  console.log("scenario 2 ok: interleaved multi-save flows both fully land");

  /* ---- Scenario 3: concurrent counter increments ----------------------- */
  const c1 = await loadState();
  const c2 = await loadState();
  c1.agents.find((a) => a.id === "coach")!.stats.drafts += 2;
  c2.agents.find((a) => a.id === "coach")!.stats.drafts += 3;
  await saveState(c1);
  await saveState(c2);
  const after3 = await loadState();
  assert.equal(
    after3.agents.find((a) => a.id === "coach")!.stats.drafts,
    5,
    "concurrent counter increments merge as deltas",
  );
  console.log("scenario 3 ok: concurrent stat increments both count");

  /* ---- Scenario 4: caps still enforced --------------------------------- */
  const capState = await loadState();
  for (let i = 0; i < 1600; i += 1) {
    pushEvent(capState, { kind: "error", agentId: "system", title: `evt ${i}`, detail: "", refId: null });
  }
  await saveState(capState);
  const after4 = await loadState();
  assert.ok(after4.events.length <= 1500, "event cap still enforced");
  console.log("scenario 4 ok: caps still enforced");

  console.log("ALL SCENARIOS PASSED");
}

void main();
