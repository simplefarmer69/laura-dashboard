import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SwarmEvent, SwarmState } from "@/lib/types";
import { DEFAULT_AGENTS, DEFAULT_SETTINGS } from "@/lib/swarm/roster";
import { archiveState } from "@/lib/swarm/archive";
import { maybeBackup } from "@/lib/swarm/backup";

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const MAX_RUNS = 200;
const MAX_METRICS = 4000;
const MAX_EVENTS = 1500;
const MAX_LESSONS = 60;

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
    researchBriefs: [],
    events: [],
    lessons: [],
    milestones: [],
    launches: [],
    lastTuneDate: null,
  };
}

let writeChain: Promise<unknown> = Promise.resolve();

export async function loadState(): Promise<SwarmState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SwarmState>;
    const base = freshState();
    const agents = base.agents.map((def) => {
      const saved = parsed.agents?.find((a) => a.id === def.id);
      return saved ? { ...def, ...saved, stats: { ...def.stats, ...saved.stats } } : def;
    });
    return {
      ...base,
      ...parsed,
      agents,
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
    };
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
  /* Deep memory: mirror every stream into the append-only SQLite archive
     BEFORE the caps below evict anything, so nothing is ever lost. Additive
     and never-throws — a failure cannot block the hot save. */
  archiveState(state);
  state.runs = state.runs.slice(-MAX_RUNS);
  state.metricsHistory = state.metricsHistory.slice(-MAX_METRICS);
  state.events = state.events.slice(-MAX_EVENTS);
  state.lessons = state.lessons.slice(-MAX_LESSONS);
  const run = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, STATE_FILE);
    /* Periodic timestamped copy of the JSON stores; cheap corruption insurance. */
    await maybeBackup();
  };
  writeChain = writeChain.then(run, run);
  await writeChain;
}

/** Read-modify-write helper serialised through the write chain. */
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

export function pushEvent(
  state: SwarmState,
  event: Omit<SwarmEvent, "id" | "ts"> & { ts?: number },
): SwarmEvent {
  const full: SwarmEvent = { id: newId("evt"), ts: event.ts ?? Date.now(), ...event };
  state.events.push(full);
  return full;
}
