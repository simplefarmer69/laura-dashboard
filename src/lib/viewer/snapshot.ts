import { loadState } from "@/lib/store";
import { isCycleRunning } from "@/lib/swarm/orchestrator";
import { schedulerRunning } from "@/lib/swarm/scheduler";
import { resolveModel } from "@/lib/swarm/llm";
import { missionStatus } from "@/lib/mission-status";
import { xStatus } from "@/lib/publish/x";
import { loadNotebook } from "@/lib/swarm/notebook";
import { loadSkills } from "@/lib/swarm/skills";
import { LAUNCHPAD } from "@/lib/launchpad/contracts";
import { LAUNCH_CAPS, launcherGrid, padState, walletStatus } from "@/lib/launchpad/service";
import type { Settings, SwarmState } from "@/lib/types";

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
const OPTIONAL_STATE_KEYS = ["intelHistory", "treasuryBuys", "intel", "influence", "forum", "utilityProjects"] as const;

function pickSettings(settings: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) out[key] = settings[key];
  return out as Partial<Settings>;
}

export async function buildPublicSnapshot(): Promise<Record<string, unknown>> {
  const state = await loadState();
  const model = resolveModel(state.settings.llmModel);
  const [notebook, skills, wallet, pad, grid] = await Promise.all([
    loadNotebook(),
    loadSkills(),
    walletStatus().catch(() => null),
    padState("weth").catch(() => null),
    launcherGrid("new", 10).catch(() => []),
  ]);
  const xs = xStatus();

  const optional: Record<string, unknown> = {};
  for (const key of OPTIONAL_STATE_KEYS) {
    const value = (state as SwarmState & Record<string, unknown>)[key];
    if (value !== undefined) optional[key] = value;
  }

  return {
    version: state.version,
    settings: pickSettings(state.settings),
    agents: state.agents,
    drafts: state.drafts,
    proposals: state.proposals,
    runs: state.runs,
    grades: state.grades,
    metricsHistory: state.metricsHistory.slice(-600),
    researchBriefs: state.researchBriefs,
    events: state.events,
    lessons: state.lessons,
    milestones: state.milestones,
    launches: state.launches,
    treasury: state.treasury ?? null,
    lastTuneDate: state.lastTuneDate,
    ...optional,
    mission: missionStatus(state, state.metricsHistory.at(-1) ?? null),
    evolution: {
      notebookCount: notebook.length,
      notebook: notebook.slice(-15).reverse(),
      skills: skills.map((s) => ({ name: s.name, description: s.description, agents: s.agents })),
    },
    runtime: {
      cycleRunning: isCycleRunning(),
      autopilot: schedulerRunning(),
      llmProvider: model.provider,
      llmModel: model.modelId,
      /* booleans only; the local console's "missing credentials" hints stay local */
      x: { appKeys: xs.appKeys, accessKeys: xs.accessKeys, ready: xs.ready, missing: [] },
    },
    /* Everything the Launchpad tab needs, captured on the VM so the viewer
       never touches the RPC or wallet code. All of it is on-chain public. */
    launchpad: {
      wallet,
      pad,
      grid,
      caps: LAUNCH_CAPS,
      explorer: LAUNCHPAD.explorer,
      factory: LAUNCHPAD.factory,
      autoExecute: state.settings.autoExecuteLaunches,
    },
    viewer: { publishedAt: Date.now() },
  };
}
