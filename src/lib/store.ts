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
const MAX_INTEL = 400;

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

let writeChain: Promise<unknown> = Promise.resolve();

export async function loadState(): Promise<SwarmState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SwarmState>;
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
  state.intelHistory = (state.intelHistory ?? []).slice(-MAX_INTEL);
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
