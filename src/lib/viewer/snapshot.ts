import { loadState } from "@/lib/store";
import { hostInfo } from "@/lib/ops";
import { isCycleRunning } from "@/lib/swarm/orchestrator";
import { runtimeActivity, schedulerRunning } from "@/lib/swarm/scheduler";
import { resolveModel } from "@/lib/swarm/llm";
import { missionStatus } from "@/lib/mission-status";
import { xStatus } from "@/lib/publish/x";
import { loadNotebook } from "@/lib/swarm/notebook";
import { loadSkills } from "@/lib/swarm/skills";
import { LAUNCHPAD } from "@/lib/launchpad/contracts";
import { LAUNCH_CAPS, allPadStates, launcherGrid, walletStatus } from "@/lib/launchpad/service";
import { launchQueueInfo } from "@/lib/launchpad/capacity";
import type { ForumThread, Settings, SwarmState } from "@/lib/types";

/**
 * Builds the sanitized, read-only snapshot the VM publishes for the public
 * viewer (laura.stonkbrokers.io). Runs ONLY on the operator's VM — never on
 * the viewer deployment, which merely stores and serves the result.
 *
 * Sanitization is whitelist-based: only the fields named here leave the VM.
 * Explicitly NEVER included: env values of any kind, API keys, the wallet
 * private key, publish secrets, or the names of missing credentials. The
 * treasury/wallet address and balances are included — they are on-chain
 * public and the console already displays them.
 */

const SETTINGS_KEYS: (keyof Settings)[] = [
  "tokenAddress",
  "chainSlug",
  "chainId",
  "llamaSlug",
  "projectName",
  "projectSite",
  "cycleIntervalMinutes",
  "maxLlmCyclesPerDay",
  "autoApplyStrategyProposals",
  "maxDraftsPerCycle",
  "llmModel",
  "autoTune",
  "autoApproveProposals",
  "autoExecuteLaunches",
  "autoClaimEarnings",
  "autoExecuteUtility",
];

/** Optional state sections (newer work streams); all public-safe by content:
    X-read intel snapshots and on-chain treasury buys (tx hashes are public). */
const OPTIONAL_STATE_KEYS = ["treasuryBuys", "intel", "influence", "utilityProjects"] as const;

/**
 * Size budget. The viewer runs on Vercel, whose functions cap request AND
 * response bodies at 4.5 MB. On 2026-09-11 the full-history snapshot crossed
 * 4.4 MB, every publish came back HTTP 413 and the public site froze for half
 * an hour while LAURA was mid-cycle. The snapshot is a live window, not the
 * archive (that stays on the host in data/): recent streams are trimmed to
 * what the console renders, and if the result is still over SOFT_BUDGET the
 * limits halve once more. Whole-history counts stay in `window` so the UI can
 * say "showing the last N of M".
 */
export const SNAPSHOT_SOFT_BUDGET_BYTES = 2_500_000;

interface WindowLimits {
  events: number;
  drafts: number;
  runs: number;
  proposals: number;
  researchBriefs: number;
  lessons: number;
  intelHistory: number;
  metricsHistory: number;
  /** Archived Cafe Bar threads kept in full (open threads always ship whole). */
  archivedThreads: number;
}

const WINDOW: WindowLimits = {
  events: 500,
  drafts: 80,
  runs: 20,
  proposals: 20,
  researchBriefs: 10,
  lessons: 30,
  intelHistory: 8,
  metricsHistory: 600,
  archivedThreads: 20,
};

function halve(limits: WindowLimits): WindowLimits {
  const out = { ...limits };
  for (const key of Object.keys(out) as (keyof WindowLimits)[]) out[key] = Math.max(1, Math.floor(out[key] / 2));
  return out;
}

function tail<T>(items: T[] | undefined, n: number): T[] {
  return (items ?? []).slice(-n);
}

function threadHeat(t: ForumThread): number {
  return t.posts.at(-1)?.ts ?? t.createdAt;
}

/** Every open thread plus the N most recently active archived ones. */
function forumWindow(threads: ForumThread[] | undefined, archivedThreads: number): ForumThread[] {
  const all = threads ?? [];
  const open = all.filter((t) => t.status === "open");
  const archived = all
    .filter((t) => t.status !== "open")
    .sort((a, b) => threadHeat(b) - threadHeat(a))
    .slice(0, archivedThreads);
  const keep = new Set([...open, ...archived].map((t) => t.id));
  return all.filter((t) => keep.has(t.id));
}

function pickSettings(settings: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) out[key] = settings[key];
  return out as Partial<Settings>;
}

/** Byte length of the snapshot as it will be sent. */
export function snapshotBytes(snapshot: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

/** Per-top-level-key sizes, largest first — for the publisher's budget log. */
export function snapshotBreakdown(snapshot: Record<string, unknown>, top = 6): string {
  return Object.entries(snapshot)
    .map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v) ?? "", "utf8")] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, n]) => `${k} ${(n / 1024).toFixed(0)}KB`)
    .join(", ");
}

export async function buildPublicSnapshot(): Promise<Record<string, unknown>> {
  const state = await loadState();
  const shared = await loadSharedSections(state);
  let limits = WINDOW;
  let snapshot = assembleSnapshot(state, shared, limits);
  if (snapshotBytes(snapshot) > SNAPSHOT_SOFT_BUDGET_BYTES) {
    limits = halve(limits);
    snapshot = assembleSnapshot(state, shared, limits);
  }
  return snapshot;
}

type SharedSections = Awaited<ReturnType<typeof loadSharedSections>>;

async function loadSharedSections(state: SwarmState) {
  const model = resolveModel(state.settings.llmModel);
  const [notebook, skills, wallet, pads, grid, host] = await Promise.all([
    loadNotebook(),
    loadSkills(),
    walletStatus().catch(() => null),
    allPadStates().catch(() => []),
    launcherGrid("new", 10).catch(() => []),
    hostInfo(),
  ]);
  return { model, notebook, skills, wallet, pads, grid, host, xs: xStatus() };
}

function assembleSnapshot(state: SwarmState, shared: SharedSections, limits: WindowLimits): Record<string, unknown> {
  const { model, notebook, skills, wallet, pads, grid, host, xs } = shared;

  const optional: Record<string, unknown> = {};
  for (const key of OPTIONAL_STATE_KEYS) {
    const value = (state as SwarmState & Record<string, unknown>)[key];
    if (value !== undefined) optional[key] = value;
  }
  const forum = forumWindow(state.forum, limits.archivedThreads);

  return {
    version: state.version,
    settings: pickSettings(state.settings),
    agents: state.agents,
    drafts: tail(state.drafts, limits.drafts),
    proposals: tail(state.proposals, limits.proposals),
    runs: tail(state.runs, limits.runs),
    grades: state.grades,
    metricsHistory: tail(state.metricsHistory, limits.metricsHistory),
    researchBriefs: tail(state.researchBriefs, limits.researchBriefs),
    events: tail(state.events, limits.events),
    lessons: tail(state.lessons, limits.lessons),
    milestones: state.milestones,
    launches: state.launches,
    treasury: state.treasury ?? null,
    lastTuneDate: state.lastTuneDate,
    ...optional,
    intelHistory: tail(state.intelHistory, limits.intelHistory),
    forum,
    /* Whole-history counts behind the trimmed streams above. */
    window: {
      events: state.events.length,
      drafts: state.drafts.length,
      runs: state.runs.length,
      proposals: state.proposals.length,
      researchBriefs: state.researchBriefs.length,
      lessons: state.lessons.length,
      forumThreads: state.forum?.length ?? 0,
      forumPosts: (state.forum ?? []).reduce((n, t) => n + t.posts.length, 0),
      forumThreadsShown: forum.length,
      forumPostsShown: forum.reduce((n, t) => n + t.posts.length, 0),
    },
    mission: missionStatus(state, state.metricsHistory.at(-1) ?? null),
    evolution: {
      notebookCount: notebook.length,
      notebook: notebook.slice(-15).reverse(),
      skills: skills.map((s) => ({ name: s.name, description: s.description, agents: s.agents })),
    },
    runtime: {
      cycleRunning: isCycleRunning(),
      autopilot: schedulerRunning(),
      /* What LAURA is doing at publish time, so the public banner states the
         phase instead of guessing "resting" from snapshot age. */
      activity: runtimeActivity(state),
      llmProvider: model.provider,
      llmModel: model.modelId,
      /* booleans only; the local console's "missing credentials" hints stay local */
      x: { appKeys: xs.appKeys, accessKeys: xs.accessKeys, ready: xs.ready, missing: [] },
      /* Where LAURA runs (daemon/dev), release sha, uptime, browser engine — the
         public site reflects the host so visitors can see she is live. */
      host,
    },
    /* Everything the Launchpad tab needs, captured on the VM so the viewer
       never touches the RPC or wallet code. All of it is on-chain public. */
    launchpad: {
      wallet,
      /* `pad` kept as the WETH lane so older viewer builds keep rendering. */
      pad: pads.find((p) => p.lane === "weth") ?? null,
      pads,
      grid,
      caps: LAUNCH_CAPS,
      explorer: LAUNCHPAD.explorer,
      factory: LAUNCHPAD.factory,
      autoExecute: state.settings.autoExecuteLaunches,
      queue: launchQueueInfo(state.launches),
    },
    viewer: { publishedAt: Date.now() },
  };
}
