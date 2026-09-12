import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Agent, ForumThread, SwarmEvent, SwarmState } from "@/lib/types";
import { DEFAULT_AGENTS, DEFAULT_SETTINGS } from "@/lib/swarm/roster";
import { archiveState } from "@/lib/swarm/archive";
import { maybeBackup } from "@/lib/swarm/backup";
import { stripLaunchSignoffs } from "@/lib/launchpad/copy";

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const MAX_RUNS = 200;
const MAX_METRICS = 4000;
const MAX_EVENTS = 1500;
const MAX_LESSONS = 60;
const MAX_INTEL = 400;
const MAX_BRIEFS = 50;
/** Purser's decision ledger; the eco trade ledger is never trimmed (caps are computed from it). */
const MAX_TREASURY_OPS = 400;

function freshState(): SwarmState {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    agents: DEFAULT_AGENTS.map((a) => ({
      ...a,
      history: [],
      stats: { ...a.stats },
    })),
    drafts: [],
    proposals: [],
    runs: [],
    grades: [],
    metricsHistory: [],
    intelHistory: [],
    researchBriefs: [],
    events: [],
    lessons: [],
    milestones: [],
    launches: [],
    lastTuneDate: null,
  };
}

/** Rebuilds a full normalized state from parsed JSON, exactly as loadState hands it out. */
function normalizeState(parsed: Partial<SwarmState>): SwarmState {
  const base = freshState();
  const agents = base.agents.map((def) => {
    const saved = parsed.agents?.find((a) => a.id === def.id);
    /* role/objective are code-owned display copy: always take the shipped
       text so roster copy updates reach existing state. strategy stays
       state-owned (the coach evolves it). */
    return saved
      ? { ...def, ...saved, role: def.role, objective: def.objective, stats: { ...def.stats, ...saved.stats } }
      : def;
  });
  /* Retired sign-off tail ("I am LAURA, an AI; ... not a promise.") is
     scrubbed from stored launch copy on load; idempotent, lands on the next
     save through the normal merge. */
  const launches = (parsed.launches ?? base.launches).map(stripLaunchSignoffs);
  return {
    ...base,
    ...parsed,
    agents,
    launches,
    settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
  };
}

/*
 * Concurrency discipline (added after the 2026-09-10 last-writer-wins clobber
 * that rolled back run_eb1097f0 and Sage's draft):
 *
 * Long flows (cycles, forum rounds) load a state snapshot once and hold it
 * for many minutes while calling LLMs, saving repeatedly along the way. Two
 * overlapping flows in this one server process each held a stale object, and
 * whichever saved last overwrote the other's records wholesale.
 *
 * The fix is rebase-on-save. Every state handed out by loadState carries a
 * hidden base snapshot (the exact raw JSON it was loaded from, tracked in a
 * WeakMap so it never serializes). saveState runs inside a process-wide
 * commit lock and, when the file changed since this writer loaded, performs
 * a three-way merge: for every record (by id) the writer created or changed
 * relative to its base, the writer's version lands; every record it did not
 * touch keeps whatever is on disk now, so concurrent writers' appends and
 * status updates survive. Agent stat counters merge as numeric deltas so
 * concurrent increments both count. Append-only streams (runs, drafts,
 * events, forum posts, launches, and the rest) union by id and are never
 * dropped by a merge; only the explicit size caps below evict old entries.
 *
 * The lock and the base map live on globalThis so Next dev HMR re-imports of
 * this module share one commit chain per process. Flows did not change: they
 * still load once, mutate their snapshot, and save. Only the commit itself
 * re-reads and merges.
 */

declare global {
  var __lauraStateCommitChain: Promise<unknown> | undefined;
  var __lauraStateBases: WeakMap<SwarmState, string> | undefined;
}

const stateBases: WeakMap<SwarmState, string> = (globalThis.__lauraStateBases ??= new WeakMap());

/** Serialises commit critical sections (read current, merge, write) in this process. */
function withCommitLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.__lauraStateCommitChain ?? Promise.resolve();
  const run = prev.then(fn, fn);
  globalThis.__lauraStateCommitChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Field-level three-way pick: the writer's value when it changed it, else the current one. */
function pick3<T>(base: T, work: T, current: T): T {
  return jsonEq(work, base) ? current : work;
}

/** Object three-way merge over the union of keys (used for settings and forum thread headers). */
function threeWayObject<T extends object>(base: T, work: T, current: T): T {
  const out = { ...current, ...work } as Record<string, unknown>;
  const b = base as Record<string, unknown>;
  const w = work as Record<string, unknown>;
  const c = current as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    out[key] = jsonEq(w[key], b[key]) ? c[key] : w[key];
  }
  return out as T;
}

/**
 * Append-only stream merge. Result is the current (on-disk) array, plus the
 * writer's new records appended, plus the writer's in-place edits applied to
 * records it actually changed since load. Records the writer never touched
 * keep their current form, so a concurrent writer's updates survive. A record
 * the caps already evicted from disk stays evicted. Sorted by time so
 * `at(-1)` style reads stay correct after appends from two writers.
 */
function mergeById<T>(
  baseArr: T[],
  workArr: T[],
  curArr: T[],
  idOf: (x: T) => string,
  tsOf: (x: T) => number,
): T[] {
  const baseById = new Map(baseArr.map((x) => [idOf(x), x]));
  const out = [...curArr];
  const outIndex = new Map(curArr.map((x, i) => [idOf(x), i]));
  for (const w of workArr) {
    const id = idOf(w);
    const b = baseById.get(id);
    const at = outIndex.get(id);
    if (!b) {
      /* Created by this writer since it loaded. */
      if (at === undefined) {
        outIndex.set(id, out.length);
        out.push(w);
      } else {
        out[at] = w;
      }
    } else if (!jsonEq(b, w) && at !== undefined) {
      /* Modified by this writer: its version wins for records it owns. */
      out[at] = w;
    }
  }
  out.sort((a, b) => tsOf(a) - tsOf(b));
  return out;
}

/** Grade stamps replace same-day entries under a fresh id; keep one per date, the newest. */
function dedupeGradesByDate(grades: SwarmState["grades"]): SwarmState["grades"] {
  const byDate = new Map<string, (typeof grades)[number]>();
  for (const g of grades) {
    const prev = byDate.get(g.date);
    if (!prev || g.ts >= prev.ts) byDate.set(g.date, g);
  }
  return [...byDate.values()].sort((a, b) => a.ts - b.ts);
}

/** Agents: roster comes from current; fields three-way, stat counters merge as deltas. */
function mergeAgents(baseArr: Agent[], workArr: Agent[], curArr: Agent[]): Agent[] {
  const merged = curArr.map((c) => {
    const w = workArr.find((a) => a.id === c.id);
    if (!w) return c;
    const b = baseArr.find((a) => a.id === c.id);
    if (!b) return w;
    const out = threeWayObject(b, w, c);
    const stats = { ...c.stats };
    for (const key of Object.keys(stats) as (keyof Agent["stats"])[]) {
      const delta = (w.stats[key] ?? 0) - (b.stats[key] ?? 0);
      stats[key] = Math.max(0, (c.stats[key] ?? 0) + delta);
    }
    return { ...out, stats };
  });
  for (const w of workArr) {
    if (!merged.some((a) => a.id === w.id)) merged.push(w);
  }
  return merged;
}

/** Forum: threads union by id; shared threads merge headers three-way and posts by id. */
function mergeForum(
  baseArr: ForumThread[],
  workArr: ForumThread[],
  curArr: ForumThread[],
): ForumThread[] {
  const baseById = new Map(baseArr.map((t) => [t.id, t]));
  const out = [...curArr];
  const outIndex = new Map(curArr.map((t, i) => [t.id, i]));
  for (const w of workArr) {
    const b = baseById.get(w.id);
    const at = outIndex.get(w.id);
    if (at === undefined) {
      if (!b || !jsonEq(b, w)) {
        outIndex.set(w.id, out.length);
        out.push(w);
      }
      continue;
    }
    if (!b) {
      out[at] = w;
      continue;
    }
    if (jsonEq(b, w)) continue;
    const c = out[at];
    const { posts: bPosts, ...bHead } = b;
    const { posts: wPosts, ...wHead } = w;
    const { posts: cPosts, ...cHead } = c;
    out[at] = {
      ...threeWayObject(bHead, wHead, cHead),
      posts: mergeById(bPosts, wPosts, cPosts, (p) => p.id, (p) => p.ts),
    };
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

/** Full-state three-way merge preserving both writers' appends and owned edits. */
function mergeStates(base: SwarmState, work: SwarmState, current: SwarmState): SwarmState {
  const merged: SwarmState = {
    version: 1,
    settings: threeWayObject(base.settings, work.settings, current.settings),
    agents: mergeAgents(base.agents, work.agents, current.agents),
    drafts: mergeById(base.drafts, work.drafts, current.drafts, (d) => d.id, (d) => d.createdAt),
    proposals: mergeById(base.proposals, work.proposals, current.proposals, (p) => p.id, (p) => p.createdAt),
    runs: mergeById(base.runs, work.runs, current.runs, (r) => r.id, (r) => r.startedAt),
    grades: dedupeGradesByDate(
      mergeById(base.grades, work.grades, current.grades, (g) => g.id, (g) => g.ts),
    ),
    metricsHistory: mergeById(
      base.metricsHistory,
      work.metricsHistory,
      current.metricsHistory,
      (m) => String(m.ts),
      (m) => m.ts,
    ),
    intelHistory: mergeById(
      base.intelHistory ?? [],
      work.intelHistory ?? [],
      current.intelHistory ?? [],
      (i) => String(i.ts),
      (i) => i.ts,
    ),
    researchBriefs: mergeById(
      base.researchBriefs,
      work.researchBriefs,
      current.researchBriefs,
      (b) => b.id,
      (b) => b.createdAt,
    ),
    events: mergeById(base.events, work.events, current.events, (e) => e.id, (e) => e.ts),
    lessons: mergeById(base.lessons, work.lessons, current.lessons, (l) => l.id, (l) => l.ts),
    milestones: mergeById(
      base.milestones,
      work.milestones,
      current.milestones,
      (m) => m.id,
      (m) => m.reachedAt,
    ),
    launches: mergeById(base.launches, work.launches, current.launches, (l) => l.id, (l) => l.createdAt),
    treasury: pick3(base.treasury, work.treasury, current.treasury),
    treasuryBuys: mergeById(
      base.treasuryBuys ?? [],
      work.treasuryBuys ?? [],
      current.treasuryBuys ?? [],
      (b) => b.id,
      (b) => b.ts,
    ),
    treasuryLp: mergeById(
      base.treasuryLp ?? [],
      work.treasuryLp ?? [],
      current.treasuryLp ?? [],
      (p) => p.id,
      (p) => p.ts,
    ),
    utilityProjects: mergeById(
      base.utilityProjects ?? [],
      work.utilityProjects ?? [],
      current.utilityProjects ?? [],
      (u) => u.id,
      (u) => u.createdAt,
    ),
    treasuryEcoTrades: mergeById(
      base.treasuryEcoTrades ?? [],
      work.treasuryEcoTrades ?? [],
      current.treasuryEcoTrades ?? [],
      (t) => t.id,
      (t) => t.ts,
    ),
    treasuryOps: mergeById(
      base.treasuryOps ?? [],
      work.treasuryOps ?? [],
      current.treasuryOps ?? [],
      (o) => o.id,
      (o) => o.ts,
    ),
    forum: mergeForum(base.forum ?? [], work.forum ?? [], current.forum ?? []),
    lastTuneDate: pick3(base.lastTuneDate, work.lastTuneDate, current.lastTuneDate),
  };
  return merged;
}

export async function loadState(): Promise<SwarmState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const state = normalizeState(JSON.parse(raw) as Partial<SwarmState>);
    stateBases.set(state, raw);
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const state = freshState();
      await saveState(state);
      return state;
    }
    throw err;
  }
}

export async function saveState(state: SwarmState): Promise<void> {
  await withCommitLock(async () => {
    const baseRaw = stateBases.get(state) ?? null;
    let diskRaw: string | null = null;
    try {
      diskRaw = await fs.readFile(STATE_FILE, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    let toWrite = state;
    if (baseRaw !== null && diskRaw !== null && diskRaw !== baseRaw) {
      /* Someone committed since this writer loaded: rebase this writer's
         deltas onto the current file instead of overwriting it wholesale. */
      const base = normalizeState(JSON.parse(baseRaw) as Partial<SwarmState>);
      const current = normalizeState(JSON.parse(diskRaw) as Partial<SwarmState>);
      toWrite = mergeStates(base, state, current);
      /* One line per rebased commit so the daemon log shows overlapping
         writers being reconciled (the 2026-09-10 clobber was silent). Forum
         post totals are the canary: merged >= max(writer, disk) always. */
      const posts = (s: SwarmState) => (s.forum ?? []).reduce((n, t) => n + t.posts.length, 0);
      console.log(
        `[store ${new Date().toISOString()}] rebased commit onto a newer state.json (forum posts writer ${posts(state)} / disk ${posts(current)} / merged ${posts(toWrite)}; events ${state.events.length} / ${current.events.length} / ${toWrite.events.length})`,
      );
    }
    /* Deep memory: mirror every stream into the append-only SQLite archive
       BEFORE the caps below evict anything, so nothing is ever lost. Additive
       and never-throws; a failure cannot block the hot save. */
    archiveState(toWrite);
    toWrite.runs = toWrite.runs.slice(-MAX_RUNS);
    toWrite.metricsHistory = toWrite.metricsHistory.slice(-MAX_METRICS);
    toWrite.intelHistory = (toWrite.intelHistory ?? []).slice(-MAX_INTEL);
    toWrite.researchBriefs = toWrite.researchBriefs.slice(-MAX_BRIEFS);
    toWrite.events = toWrite.events.slice(-MAX_EVENTS);
    toWrite.lessons = toWrite.lessons.slice(-MAX_LESSONS);
    if (toWrite.treasuryOps) toWrite.treasuryOps = toWrite.treasuryOps.slice(-MAX_TREASURY_OPS);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const json = JSON.stringify(toWrite, null, 2);
    const tmp = `${STATE_FILE}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, json, "utf8");
    await fs.rename(tmp, STATE_FILE);
    /* Advance this writer's base to what it holds now, so the next save only
       carries deltas made after this commit. */
    stateBases.set(state, toWrite === state ? json : JSON.stringify(state, null, 2));
    /* Periodic timestamped copy of the JSON stores; cheap corruption insurance. */
    await maybeBackup();
  });
}

/** Read-modify-write helper. Short-lived by convention; the merge-on-save
 *  commit makes it safe against overlapping long flows either way. */
export async function updateState<T>(
  fn: (state: SwarmState) => T | Promise<T>,
): Promise<T> {
  const state = await loadState();
  const result = await fn(state);
  await saveState(state);
  return result;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/* Secret redaction net, pattern ported from the operator's ape-claw telemetry
   (its Feb-2026 audit rated unredacted telemetry CRITICAL). Event titles and
   details ship verbatim into the public dashboard snapshot, and error strings
   from viem/fetch can embed full request URLs — including an RPC URL that may
   carry key material. Mask the values of secret-shaped env vars before an
   event is stored. Exact-value matching only: tx hashes and addresses are
   never touched. */
const SENSITIVE_ENV_NAME = /(KEY|TOKEN|SECRET|PRIVATE|MNEMONIC|SEED|PASSWORD|RPC_URL)/i;
const MIN_SECRET_LENGTH = 10;

let sensitiveEnvValues: string[] | null = null;

function secretValues(): string[] {
  if (sensitiveEnvValues) return sensitiveEnvValues;
  sensitiveEnvValues = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        SENSITIVE_ENV_NAME.test(name) &&
        typeof value === "string" &&
        value.length >= MIN_SECRET_LENGTH,
    )
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  return sensitiveEnvValues;
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const value of secretValues()) {
    if (out.includes(value)) out = out.split(value).join("[REDACTED]");
  }
  return out;
}

export function pushEvent(
  state: SwarmState,
  event: Omit<SwarmEvent, "id" | "ts"> & { ts?: number },
): SwarmEvent {
  const full: SwarmEvent = {
    id: newId("evt"),
    ts: event.ts ?? Date.now(),
    ...event,
    title: redactSecrets(event.title),
    detail: redactSecrets(event.detail),
  };
  state.events.push(full);
  return full;
}
