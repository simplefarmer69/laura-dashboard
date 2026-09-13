import type { ForgeProject, SwarmState } from "@/lib/types";

/**
 * Pure caps + eligibility math for Anvil, shared by the executor and any
 * console surface. No node/viem imports: client-bundle safe.
 *
 * HARD CODE-LEVEL CAPS. Anvil's autonomy grant (operator directive
 * 2026-09-13) rests on these the same way launches rest on LAUNCH_CAPS: they
 * fail closed and never bend. Env overrides can only SHRINK them.
 */
export const FORGE_CAPS = {
  /** Contract deploys per rolling 24h */
  maxDeploysPerDay: 2,
  /** Contract deploys per rolling 7 days */
  maxDeploysPerWeek: 8,
  /** Minimum hours between two deploys */
  minDeployGapHours: 3,
  /** Projects in flight (approved or deployed-but-unverified) at once */
  maxActiveProjects: 1,
  /** Never spend the wallet under this ETH balance (shared floor with the treasury caps) */
  treasuryFloorEth: 0.35,
  /** Refuse a deploy whose estimated gas cost exceeds this much ETH */
  maxDeployCostEth: 0.003,
  /** Gas limit ceiling on the deploy transaction */
  maxDeployGas: 3_000_000,
  /** Source length ceiling (characters) */
  maxSourceChars: 7_000,
  /** Creation bytecode ceiling (bytes); EIP-170 is 24,576 for runtime code */
  maxBytecodeBytes: 16_384,
  /** Compile-and-repair rounds per design before the design is dropped */
  maxCompileAttempts: 3,
  /** Verification attempts before the project is marked failed (still deployed, just unverified) */
  maxVerifyAttempts: 8,
} as const;

export type ForgeCaps = { -readonly [K in keyof typeof FORGE_CAPS]: number };

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;

/** Projects still occupying a slot: approved and waiting, or deployed and awaiting verification. */
export function activeForgeProjects(state: SwarmState): ForgeProject[] {
  return (state.forgeProjects ?? []).filter((p) => p.status === "pending" || p.status === "approved" || p.status === "deployed");
}

export function forgeDeploysSince(state: SwarmState, sinceTs: number): ForgeProject[] {
  return (state.forgeProjects ?? []).filter((p) => p.deployedAt !== null && p.deployedAt > sinceTs);
}

export interface ForgeEligibility {
  eligible: boolean;
  reason: string;
  /** Earliest timestamp a deploy can fire (0 = now) */
  nextEligibleAt: number;
}

/** Pure caps math over the project ledger; balances and gas are checked at send time. */
export function forgeDeployEligibility(state: SwarmState, now = Date.now(), caps: ForgeCaps = FORGE_CAPS): ForgeEligibility {
  const day = forgeDeploysSince(state, now - DAY_MS);
  const week = forgeDeploysSince(state, now - WEEK_MS);
  if (day.length >= caps.maxDeploysPerDay) {
    const oldest = Math.min(...day.map((p) => p.deployedAt ?? now));
    return { eligible: false, reason: `daily cap: ${day.length}/${caps.maxDeploysPerDay} deploys in 24h`, nextEligibleAt: oldest + DAY_MS };
  }
  if (week.length >= caps.maxDeploysPerWeek) {
    const oldest = Math.min(...week.map((p) => p.deployedAt ?? now));
    return { eligible: false, reason: `weekly cap: ${week.length}/${caps.maxDeploysPerWeek} deploys in 7d`, nextEligibleAt: oldest + WEEK_MS };
  }
  const last = Math.max(0, ...(state.forgeProjects ?? []).map((p) => p.deployedAt ?? 0));
  const gapMs = caps.minDeployGapHours * 3600_000;
  if (last > 0 && now - last < gapMs) {
    return {
      eligible: false,
      reason: `gap: last deploy ${Math.round((now - last) / 60_000)} min ago, ${caps.minDeployGapHours}h required`,
      nextEligibleAt: last + gapMs,
    };
  }
  return { eligible: true, reason: "within caps", nextEligibleAt: 0 };
}

/** Whether Anvil may DESIGN a new project this cycle (slots, not spend). */
export function forgeGate(state: SwarmState, caps: ForgeCaps = FORGE_CAPS): { blocked: boolean; reason: string } {
  const active = activeForgeProjects(state);
  if (active.length >= caps.maxActiveProjects) {
    const p = active[0];
    return { blocked: true, reason: `${active.length}/${caps.maxActiveProjects} project in flight (${p.title}: ${p.status}); design waits until it ships or fails` };
  }
  return { blocked: false, reason: "" };
}

/** Compact ledger for prompts and dashboards. */
export function forgeProjectsDigest(state: SwarmState, limit = 8): string {
  const all = state.forgeProjects ?? [];
  if (all.length === 0) return "No contracts yet.";
  return all
    .slice(-limit)
    .reverse()
    .map((p) => {
      const when = new Date(p.deployedAt ?? p.createdAt).toISOString().slice(0, 10);
      const where = p.contractAddress ? ` at ${p.contractAddress}` : "";
      const via = p.verifiedVia ? ` (verified via ${p.verifiedVia}, ${p.explorerUrl ?? "explorer"})` : "";
      const kind = p.kind === "flagship" ? "FLAGSHIP, audited in-repo, guide https://github.com/simplefarmer69/laura-dashboard/blob/main/docs/OWNERSHIP-MARKET.md" : "Anvil design";
      return `- ${when} · ${p.title} [${p.status}; ${kind}]${where}${via}: ${p.blurb} · for: ${p.need.slice(0, 160)}`;
    })
    .join("\n");
}

export function forgeCapacityDigest(state: SwarmState, now = Date.now(), caps: ForgeCaps = FORGE_CAPS): string {
  const day = forgeDeploysSince(state, now - DAY_MS).length;
  const week = forgeDeploysSince(state, now - WEEK_MS).length;
  const elig = forgeDeployEligibility(state, now, caps);
  const lines = [
    `- Deploys: ${day}/${caps.maxDeploysPerDay} in 24h, ${week}/${caps.maxDeploysPerWeek} in 7d, ${caps.minDeployGapHours}h gap between deploys`,
    `- Next deploy slot: ${elig.eligible ? "open now" : `${elig.reason}; opens ${new Date(elig.nextEligibleAt).toISOString()}`}`,
    `- Source ceiling ${caps.maxSourceChars} chars, bytecode ceiling ${caps.maxBytecodeBytes} bytes, gas ceiling ${caps.maxDeployGas.toLocaleString()}, cost ceiling ${caps.maxDeployCostEth} ETH, treasury floor ${caps.treasuryFloorEth} ETH`,
    `- Execution flag: autoExecuteForge is ${state.settings.autoExecuteForge ? "ON, approved contracts deploy" : "OFF, contracts queue until the operator enables it"}`,
  ];
  return lines.join("\n");
}
