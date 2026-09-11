import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

/**
 * One-shot repair for the 2026-09-10 last-writer-wins clobbers (see the
 * store.ts rebase-on-save commit). Everything here is additive or fixes a
 * specific stuck field, sourced from the append-only SQLite archive:
 *
 * 1. run_eb1097f0: restore finishedAt and counters from the archived
 *    cycle.finished event, with an explanatory error note.
 * 2. Restore Sage's draft draft_a5325e8b and Sage's stats (first-ever pass).
 * 3. Restore prop_80009979 and replay Broker's auto-adopted strategy v4.
 * 4. Restore coach's lost markRan, reset agents stuck in "running".
 * 5. Reconstruct Cafe Bar rounds 4 and 5 (12 threads, 118 posts) from the
 *    event log; full bodies were lost, so each carries the surviving 200
 *    character excerpt plus an explicit recovery marker.
 * 6. Restore the clobbered events themselves (forum, sage, coach, finish).
 *
 * Safety: copies state.json into data/backups/ first, refuses to write if
 * state.json changed while the script was building the repair, writes via
 * tmp + atomic rename. Never deletes or regresses anything.
 */

const DATA_DIR = process.env.SWARM_DATA_DIR ?? "/workspace/data";
const STATE_FILE = path.join(DATA_DIR, "state.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DB_FILE = path.join(DATA_DIR, "archive", "archive.db");

const CYCLE_FINISHED_TS = 1789081904609; // archived cycle.finished event ts
const PROPOSAL_TS_GUARD = 1789081700000; // just before 23:09:12
const ROUND4_ID = "fround_c5b2bafa";
const ROUND5_ID = "fround_92bcff90";
const ROUND_SPLIT_TS = 1789080100000; // 22:41:40, between round 4 end and round 5 start
const RECOVERY_MARKER =
  "\n\n[recovered 2026-09-10: the full text of this post was lost when a concurrent cycle's stale save rolled back the venue; the first 200 characters were restored from the event log]";

const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const raw = fs.readFileSync(STATE_FILE, "utf8");
const mtimeAtRead = fs.statSync(STATE_FILE).mtimeMs;
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const backupFile = path.join(BACKUP_DIR, `state-prerepair-${stamp}.json`);
fs.writeFileSync(backupFile, raw);
console.log(`backup written: ${backupFile}`);

const state = JSON.parse(raw);
const db = new Database(DB_FILE, { readonly: true });
const notes = [];

const getArchived = (stream, id) => {
  const row = db.prepare("SELECT json FROM items WHERE stream=? AND id=?").get(stream, id);
  return row ? JSON.parse(row.json) : null;
};

/* ---- 1. run_eb1097f0 finalization ---------------------------------------- */
const run = state.runs.find((r) => r.id === "run_eb1097f0");
if (run && run.finishedAt === null) {
  run.finishedAt = CYCLE_FINISHED_TS;
  run.error =
    "Record repaired 2026-09-10: this cycle finished successfully at 23:11:44 UTC (7 drafts, 1 proposal per its archived cycle.finished event), but a concurrent Cafe Bar round's stale snapshot save rolled the record back to unfinished. finishedAt and counters restored from the archive; steps recorded after ~23:02 UTC were lost.";
  notes.push("run_eb1097f0 finalized from archived cycle.finished event");
}
if (run && run.finishedAt !== null && run.draftsCreated === 6 && run.proposalsCreated === 0) {
  /* Counters per the archived cycle.finished event: 7 drafts, 1 proposal.
     The finalizing repair (done concurrently by another operator pass) kept
     the stale snapshot's 6/0. Keep their explanatory note untouched. */
  run.draftsCreated = 7;
  run.proposalsCreated = 1;
  notes.push("run_eb1097f0 counters corrected to 7 drafts / 1 proposal per cycle.finished event");
}

/* ---- 2. Sage draft + stats ------------------------------------------------ */
if (!state.drafts.some((d) => d.id === "draft_a5325e8b")) {
  const draft = getArchived("drafts", "draft_a5325e8b");
  if (draft) {
    state.drafts.push(draft);
    state.drafts.sort((a, b) => a.createdAt - b.createdAt);
    notes.push("draft_a5325e8b restored from archive");
  }
}
let sage = state.agents.find((a) => a.id === "sage");
if (!sage) {
  /* The pre-restart scheduler loop (stale module snapshot, roster without
     sage) drops sage from the file on its saves; reinsert the roster entry.
     Role/objective/strategy are code-owned and re-applied by loadState, so
     placeholders are safe here. */
  sage = {
    id: "sage",
    name: "Sage",
    role: "Collective intelligence & evolution",
    objective: "(code-owned, restored by loadState)",
    strategy:
      "Run on a stride (every other cycle at most) and make ONE deep pass per run, assigned by rotation (distill, study, audit, curate). Writes flow only through the safe channels: library docs outside the protected operator files, skills, notebook.",
    strategyVersion: 1,
    versionAdoptedAt: null,
    gradeAtVersionAdoption: null,
    history: [],
    status: "idle",
    lastRunAt: null,
    lastError: null,
    stats: { runs: 0, drafts: 0, approved: 0, rejected: 0, published: 0 },
  };
  state.agents.push(sage);
  notes.push("sage agent reinserted (dropped by the stale-roster scheduler save)");
}
const sageEvt = db
  .prepare("SELECT json FROM items WHERE stream='events' AND json LIKE '%draft_a5325e8b%' AND json LIKE '%draft.created%'")
  .get();
const sageEvtId = sageEvt ? JSON.parse(sageEvt.json).id : null;
const sageAlreadyRepaired = sageEvtId !== null && state.events.some((e) => e.id === sageEvtId);
if (!sageAlreadyRepaired) {
  /* Delta increments for the lost 23:11 pass, so a live cycle's own sage
     increments are preserved whichever lands first. */
  sage.stats.runs += 1;
  sage.stats.drafts += 1;
  sage.stats.approved += 1;
  if ((sage.lastRunAt ?? 0) < CYCLE_FINISHED_TS) sage.lastRunAt = CYCLE_FINISHED_TS;
  sage.lastError = null;
  notes.push("sage stats restored (lost collective intelligence pass: +1 run, +1 draft, +1 approved)");
}

/* ---- 3. Broker strategy v4 + proposal ------------------------------------ */
const prop = getArchived("proposals", "prop_80009979");
if (prop && !state.proposals.some((p) => p.id === prop.id)) {
  state.proposals.push(prop);
  state.proposals.sort((a, b) => a.createdAt - b.createdAt);
  notes.push("prop_80009979 restored from archive");
}
const bd = state.agents.find((a) => a.id === "bd");
if (prop && bd && bd.strategyVersion === prop.fromVersion) {
  const grade = state.grades.at(-1)?.score ?? null;
  bd.history.push({
    version: bd.strategyVersion,
    strategy: bd.strategy,
    adoptedAt: bd.versionAdoptedAt ?? 0,
    reason: "Superseded: Auto-approved: full autonomy enabled",
    gradeAtAdoption: bd.gradeAtVersionAdoption,
    gradeAtRetirement: grade,
  });
  bd.strategy = prop.proposedStrategy;
  bd.strategyVersion = prop.fromVersion + 1;
  bd.versionAdoptedAt = prop.createdAt;
  bd.gradeAtVersionAdoption = grade;
  notes.push(`broker (bd) strategy v${bd.strategyVersion} re-adopted (was rolled back to v${prop.fromVersion})`);
}

/* ---- 4. Coach markRan + stuck running agents ------------------------------ */
const coach = state.agents.find((a) => a.id === "coach");
const coachEvt = db
  .prepare("SELECT json FROM items WHERE stream='events' AND json LIKE '%prop_80009979%' AND json LIKE '%proposal.created%'")
  .get();
const coachEvtId = coachEvt ? JSON.parse(coachEvt.json).id : null;
const coachAlreadyRepaired = coachEvtId !== null && state.events.some((e) => e.id === coachEvtId);
if (coach && !coachAlreadyRepaired) {
  coach.stats.runs += 1;
  if ((coach.lastRunAt ?? 0) < PROPOSAL_TS_GUARD) coach.lastRunAt = prop?.createdAt ?? CYCLE_FINISHED_TS;
  coach.lastError = null;
  notes.push("coach markRan restored (runs +1)");
}
/* Reset agents stuck in "running" ONLY when no cycle is legitimately in
   flight (a live cycle sets non-paused agents to running by design and its
   finally block restores idle). */
const latest = state.runs.at(-1);
const cycleInFlight = latest && latest.finishedAt === null && Date.now() - latest.startedAt < 30 * 60_000;
if (!cycleInFlight) {
  const stuck = state.agents.filter((a) => a.status === "running");
  for (const a of stuck) a.status = "idle";
  if (stuck.length > 0) notes.push(`reset stuck running agents to idle: ${stuck.map((a) => a.id).join(", ")}`);
} else {
  notes.push(`agent status reset skipped: cycle ${latest.id} is in flight`);
}

/* ---- 5 + 6. Forum rounds 4/5 reconstruction and event restores ------------ */
const stateEventIds = new Set(state.events.map((e) => e.id));
const missingEvents = [];
const rows = db
  .prepare("SELECT json FROM items WHERE stream='events' AND ts BETWEEN ? AND ? ORDER BY ts")
  .all(1789078900000, 1789082000000); // 22:21:40 to 23:13:20 window (round 4 start through cycle finish)
for (const { json } of rows) {
  const e = JSON.parse(json);
  if (stateEventIds.has(e.id)) continue;
  if (["forum.post", "forum.thread", "proposal.created", "proposal.adopted", "draft.created", "library.updated", "note.recorded", "cycle.finished"].includes(e.kind)) {
    missingEvents.push(e);
  }
}

state.forum = state.forum ?? [];
const threadByTitle = (title) => {
  const hits = state.forum.filter((t) => t.title === title);
  return hits.at(-1) ?? null;
};
const postIds = new Set(state.forum.flatMap((t) => t.posts.map((p) => p.id)));
const roundFor = (ts) => (ts <= ROUND_SPLIT_TS ? ROUND4_ID : ROUND5_ID);
let threadsRebuilt = 0;
let postsRebuilt = 0;
let closuresReapplied = 0;
let fallback = null;
const fallbackThread = () => {
  if (!fallback) {
    fallback = {
      id: `thread_${randomUUID().slice(0, 8)}`,
      title: "Recovered posts from Cafe Bar rounds 4 and 5 (2026-09-10)",
      tag: "ops",
      createdBy: "barkeep",
      createdAt: 1789079000000,
      status: "archived",
      posts: [],
      closedBy: "system",
      closedReason: "Container for recovered round 4/5 posts whose original thread could not be matched by title.",
      closedAt: Date.now(),
    };
    state.forum.push(fallback);
  }
  return fallback;
};

const forumEvents = missingEvents
  .filter((e) => e.kind === "forum.thread" || e.kind === "forum.post")
  .sort((a, b) => a.ts - b.ts);
for (const e of forumEvents) {
  if (e.kind === "forum.thread") {
    const poured = e.title.match(/^Tabs poured a fresh one: ([\s\S]*)$/);
    const opened = e.title.match(/^.+ opened in The Cafe Bar: ([\s\S]*)$/);
    const title = (poured ?? opened)?.[1];
    if (!title || threadByTitle(title)) continue;
    const thread = {
      id: e.refId ?? `thread_${randomUUID().slice(0, 8)}`,
      title,
      tag: "off-topic",
      createdBy: e.agentId,
      createdAt: e.ts,
      status: "open",
      posts: [],
    };
    thread.posts.push({
      id: `post_${randomUUID().slice(0, 8)}`,
      threadId: thread.id,
      agentId: e.agentId,
      ts: e.ts,
      roundId: roundFor(e.ts),
      body: `${e.detail}${RECOVERY_MARKER}`,
    });
    state.forum.push(thread);
    threadsRebuilt += 1;
    postsRebuilt += 1;
    continue;
  }
  /* forum.post */
  if (e.refId && postIds.has(e.refId)) continue;
  const lastCall = e.title.match(/^Tabs rang last call on "([\s\S]*)"$/);
  const reply = e.title.match(/^.+ in "([\s\S]*)"$/);
  const title = (lastCall ?? reply)?.[1];
  const thread = (title && threadByTitle(title)) || fallbackThread();
  const body = lastCall
    ? `Last call. ${e.detail}\n\n[recovered 2026-09-10: the closing reason above survived in the event log; the host's original last call post text was lost to a concurrent cycle's stale save]`
    : `${e.detail}${RECOVERY_MARKER}`;
  thread.posts.push({
    id: e.refId ?? `post_${randomUUID().slice(0, 8)}`,
    threadId: thread.id,
    agentId: e.agentId,
    ts: e.ts,
    roundId: roundFor(e.ts),
    body,
  });
  if (e.refId) postIds.add(e.refId);
  postsRebuilt += 1;
  if (lastCall && thread.status === "open" && thread !== fallback) {
    thread.status = "archived";
    thread.closedBy = "barkeep";
    thread.closedReason = e.detail;
    thread.closedAt = e.ts;
    closuresReapplied += 1;
  }
}
for (const t of state.forum) t.posts.sort((a, b) => a.ts - b.ts);
state.forum.sort((a, b) => a.createdAt - b.createdAt);
notes.push(`forum rounds 4/5 reconstructed: ${threadsRebuilt} threads, ${postsRebuilt} posts, ${closuresReapplied} closures reapplied`);

let eventsRestored = 0;
for (const e of missingEvents) {
  if (stateEventIds.has(e.id)) continue;
  state.events.push(e);
  stateEventIds.add(e.id);
  eventsRestored += 1;
}
state.events.sort((a, b) => a.ts - b.ts);
state.events = state.events.slice(-1500);
notes.push(`${eventsRestored} clobbered events restored into the timeline`);

/* ---- Write, guarded ------------------------------------------------------- */
if (fs.statSync(STATE_FILE).mtimeMs !== mtimeAtRead) {
  console.error("ABORT: state.json changed while the repair was being built. Re-run in a quiet moment.");
  process.exit(1);
}
const tmp = `${STATE_FILE}.${randomUUID()}.repair.tmp`;
fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
fs.renameSync(tmp, STATE_FILE);
console.log("repair applied:");
for (const n of notes) console.log(`  - ${n}`);
