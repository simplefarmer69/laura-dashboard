import { z } from "zod";
import { pushEvent } from "@/lib/store";
import { missionDigest } from "@/lib/mission-status";
import { forumDigest } from "@/lib/swarm/forum";
import { reviewerFeedback, recentOutputDigest } from "@/lib/swarm/context";
import { writeSkill } from "@/lib/swarm/skills";
import { STRATEGY_BUDGET_CHARS, type CycleContext } from "@/lib/swarm/tasks";
import type { Agent, DraftKind, SwarmState } from "@/lib/types";

/**
 * Hive, the swarm architect: the one agent whose product is the roster.
 *
 * Operator directive 2026-09-13: "add more swarm bots and add a bot that
 * continues to add more bots to the swarm and self improve them". Hive runs on
 * a stride, reads the roster's record, and takes ONE action per run inside
 * code-level caps: create a dynamic producer (id assigned here, never by the
 * model), rewrite a dynamic agent's brief from evidence, or retire one.
 * Static agents are out of its reach: Coach and Forge evolve those.
 *
 * Dynamic agents are ordinary producers: they draft with the kinds Hive gave
 * them, the Auditor and Redline review them like everyone else, the Coach
 * and Forge upgrade them, and every one of them inherits the charter through
 * agentSystem(). Retirement keeps the record and stops the runs.
 */

export const MAX_DYNAMIC_AGENTS = 6;
export const ARCHITECT_STRIDE_MS = 6 * 60 * 60_000;
/** Minimum reviewed sample before a retirement verdict can stand. */
const MIN_RETIRE_SAMPLE = 6;

const DRAFT_KINDS = ["post", "article", "community", "outreach", "report"] as const;

export const architectActionSchema = z.object({
  type: z.enum(["create", "improve", "retire", "skip"]),
  /** Target dynamic agent id for improve/retire. */
  agentId: z.string().optional(),
  name: z.string().min(2).max(24).optional(),
  role: z.string().min(4).max(90).optional(),
  objective: z.string().min(20).max(400).optional(),
  strategy: z.string().min(200).max(STRATEGY_BUDGET_CHARS).optional(),
  kinds: z.array(z.enum(DRAFT_KINDS)).min(1).max(2).optional(),
  skill: z
    .object({
      name: z.string().min(3).max(60),
      description: z.string().min(10).max(200),
      body: z.string().min(80).max(6000),
    })
    .nullable()
    .optional(),
  /** The evidence: what job is unowned, what the record shows, why now. */
  reason: z.string().max(900),
});

export const architectSchema = z.object({
  /** One paragraph on the roster's health: who earns their place, who does not, what job is unowned. */
  assessment: z.string().max(1200),
  action: architectActionSchema,
});

export type ArchitectOut = z.infer<typeof architectSchema>;

export function dynamicAgents(state: SwarmState): Agent[] {
  return state.agents.filter((a) => a.dynamic === true);
}

export function activeDynamicAgents(state: SwarmState): Agent[] {
  return dynamicAgents(state).filter((a) => !a.retiredAt);
}

function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16);
  return `dyn_${slug || "agent"}_${Math.random().toString(36).slice(2, 6)}`;
}

export function architectPrompt(ctx: CycleContext, state: SwarmState): string {
  const alive = activeDynamicAgents(state);
  const retired = dynamicAgents(state).filter((a) => a.retiredAt);
  const statics = state.agents.filter((a) => !a.dynamic);
  const rosterLines = statics
    .map(
      (a) =>
        `- ${a.id} (${a.name}) v${a.strategyVersion}: ${a.role}. ${a.stats.drafts} drafts / ${a.stats.approved} approved / ${a.stats.rejected} rejected / ${a.stats.published} published.`,
    )
    .join("\n");
  const dossiers = alive.length
    ? alive
        .map((a) => {
          const age = a.createdAt ? `${((Date.now() - a.createdAt) / 3_600_000).toFixed(0)}h old` : "age unknown";
          return [
            `### ${a.id} (${a.name}) — ${a.role} — ${age}, v${a.strategyVersion}, kinds ${(a.kinds ?? []).join("/")}`,
            `Objective: ${a.objective}`,
            `Stats: ${a.stats.drafts} drafts, ${a.stats.approved} approved, ${a.stats.rejected} rejected, ${a.stats.published} published.`,
            `Strategy (${a.strategy.length} chars):\n${a.strategy}`,
            `Recent output:\n${recentOutputDigest(ctx.drafts, a.id, 3)}`,
            `Reviewer decisions:\n${reviewerFeedback(ctx.drafts, a.id, 6)}`,
          ].join("\n");
        })
        .join("\n\n")
    : "No dynamic agents exist yet. The roster below is entirely static.";
  const retiredLines = retired.length
    ? retired.map((a) => `- ${a.id} (${a.name}): retired ${a.retiredAt ? new Date(a.retiredAt).toISOString().slice(0, 10) : "?"} — ${a.retiredReason ?? "no reason recorded"}`).join("\n")
    : "None.";
  return [
    `TODAY (UTC): ${ctx.grade.date}.`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `GRADE TODAY\n${ctx.grade.summary}\n${ctx.grade.components.map((c) => `- ${c.label}: ${c.score.toFixed(0)}/100 - ${c.detail}`).join("\n")}`,
    `SWARM MEMORY (banked lessons)\n${ctx.lessons.slice(-8).map((l) => `- ${l.text}`).join("\n") || "None yet."}`,
    `YOUR SKILLS\n${ctx.skills.architect ?? "None."}`,
    `LIBRARY (durable build knowledge; a new agent's brief must stay consistent with it)\n${ctx.library.slice(0, 6000)}`,
    `THE CAFE BAR (what the agents are debating; unowned jobs surface here first)\n${forumDigest(state.forum ?? []).slice(0, 2500)}`,
    `STATIC ROSTER (not yours to change; know what is already covered)\n${rosterLines}`,
    `YOUR DYNAMIC AGENTS (${alive.length}/${MAX_DYNAMIC_AGENTS} alive)\n${dossiers}`,
    `RETIRED\n${retiredLines}`,
    `DECIDE ONE ACTION. create: only when a concrete, recurring job has no owner on either roster and would move price, revenue or volume; give name (2-24 chars, one word preferred, not a name already on the roster), role, objective, a complete operating strategy (200-${STRATEGY_BUDGET_CHARS} chars: what it reads, what it produces each cycle, how it judges itself, what it never does), 1-2 kinds from ${DRAFT_KINDS.join(", ")}, and optionally one skill file with its operating procedure (the skill ships into its prompt every cycle). Do not choose an id; code assigns it. Cap: ${MAX_DYNAMIC_AGENTS} alive, one creation per run; when the cap is full, improve or retire instead. improve: agentId of a dynamic agent plus a full replacement strategy grounded in the reviewer decisions and output you cite. retire: agentId plus the evidence, only after at least ${MIN_RETIRE_SAMPLE} reviewed drafts, when most were vetoed or held, or when the job it was built for no longer exists. skip: when the roster is healthy and no unowned job is worth an agent; say so with evidence. Every new agent speaks as LAURA, inherits the charter and the X style guide, never trades, never launches, never touches the wallet; those rails belong to static agents. Honesty rules apply to every brief you write: no return promises, no manufactured urgency, no sockpuppets.`,
  ].join("\n\n");
}

export function architectMock(state: SwarmState): ArchitectOut {
  return {
    assessment: `Deterministic fallback (no live model): ${activeDynamicAgents(state).length} dynamic agent(s) alive; roster changes need a live model reading the record.`,
    action: { type: "skip", reason: "No live model this run; the roster stays as it is." },
  };
}

export interface ArchitectApplyResult {
  summary: string;
  changed: boolean;
}

/**
 * Applies Hive's action to state in place (caller saves). Every cap is
 * re-checked here, never trusted from the model: alive count, one creation per
 * run, dynamic-only targets, strategy budget, minimum retire sample.
 */
export async function applyArchitectAction(state: SwarmState, out: ArchitectOut): Promise<ArchitectApplyResult> {
  const a = out.action;
  const alive = activeDynamicAgents(state);
  switch (a.type) {
    case "skip":
      return { summary: `skip: ${a.reason.slice(0, 200)}`, changed: false };
    case "create": {
      if (alive.length >= MAX_DYNAMIC_AGENTS) return { summary: `create refused: ${MAX_DYNAMIC_AGENTS} dynamic agents already alive`, changed: false };
      if (!a.name || !a.role || !a.objective || !a.strategy || !a.kinds?.length) return { summary: "create refused: incomplete brief (name, role, objective, strategy and kinds are all required)", changed: false };
      const nameTaken = state.agents.some((x) => x.name.toLowerCase() === a.name!.toLowerCase() && !x.retiredAt);
      if (nameTaken) return { summary: `create refused: the name ${a.name} is already on the roster`, changed: false };
      const id = slugId(a.name) as Agent["id"];
      const agent: Agent = {
        id,
        name: a.name,
        role: a.role,
        objective: a.objective,
        strategy: a.strategy,
        strategyVersion: 1,
        versionAdoptedAt: Date.now(),
        gradeAtVersionAdoption: null,
        history: [],
        status: "idle",
        lastRunAt: null,
        lastError: null,
        stats: { runs: 0, drafts: 0, approved: 0, rejected: 0, published: 0 },
        dynamic: true,
        createdAt: Date.now(),
        createdBy: "architect",
        kinds: a.kinds as DraftKind[],
        retiredAt: null,
        retiredReason: null,
      };
      state.agents.push(agent);
      let skillNote = "";
      if (a.skill) {
        try {
          const res = await writeSkill({ name: a.skill.name, description: a.skill.description, agents: [id], body: a.skill.body });
          skillNote = ` · skill ${res.file} ${res.created ? "created" : "updated"}`;
          pushEvent(state, {
            kind: "skill.updated",
            agentId: "architect",
            title: `Hive wrote a skill for ${agent.name}: ${a.skill.name}`,
            detail: a.skill.description,
            refId: id,
          });
        } catch (err) {
          skillNote = ` · skill refused: ${String(err).slice(0, 120)}`;
        }
      }
      pushEvent(state, {
        kind: "roster.created",
        agentId: "architect",
        title: `Hive created a new agent: ${agent.name} (${agent.role})`,
        detail: `${a.reason}\nObjective: ${agent.objective}\nKinds: ${agent.kinds?.join(", ")}${skillNote}`,
        refId: id,
      });
      return { summary: `created ${agent.name} (${id}) for ${agent.role}${skillNote}`, changed: true };
    }
    case "improve": {
      const target = a.agentId ? state.agents.find((x) => x.id === a.agentId) : undefined;
      if (!target || !target.dynamic) return { summary: `improve refused: ${a.agentId ?? "?"} is not a dynamic agent`, changed: false };
      if (target.retiredAt) return { summary: `improve refused: ${target.name} is retired`, changed: false };
      if (!a.strategy) return { summary: "improve refused: no replacement strategy", changed: false };
      target.history.push({
        version: target.strategyVersion,
        strategy: target.strategy,
        adoptedAt: target.versionAdoptedAt ?? target.createdAt ?? Date.now(),
        reason: a.reason.slice(0, 400),
        gradeAtAdoption: target.gradeAtVersionAdoption,
        gradeAtRetirement: null,
      });
      target.strategy = a.strategy;
      target.strategyVersion += 1;
      target.versionAdoptedAt = Date.now();
      if (a.role) target.role = a.role;
      if (a.objective) target.objective = a.objective;
      if (a.kinds?.length) target.kinds = a.kinds as DraftKind[];
      pushEvent(state, {
        kind: "roster.improved",
        agentId: "architect",
        title: `Hive rewrote ${target.name}'s brief (v${target.strategyVersion})`,
        detail: a.reason,
        refId: target.id,
      });
      return { summary: `improved ${target.name} to v${target.strategyVersion}`, changed: true };
    }
    case "retire": {
      const target = a.agentId ? state.agents.find((x) => x.id === a.agentId) : undefined;
      if (!target || !target.dynamic) return { summary: `retire refused: ${a.agentId ?? "?"} is not a dynamic agent`, changed: false };
      if (target.retiredAt) return { summary: `retire refused: ${target.name} is already retired`, changed: false };
      const reviewed = target.stats.approved + target.stats.rejected + target.stats.published;
      if (reviewed < MIN_RETIRE_SAMPLE) return { summary: `retire refused: ${target.name} has only ${reviewed} reviewed drafts (< ${MIN_RETIRE_SAMPLE})`, changed: false };
      target.retiredAt = Date.now();
      target.retiredReason = a.reason.slice(0, 400);
      target.status = "idle";
      pushEvent(state, {
        kind: "roster.retired",
        agentId: "architect",
        title: `Hive retired ${target.name}`,
        detail: a.reason,
        refId: target.id,
      });
      return { summary: `retired ${target.name}: ${a.reason.slice(0, 160)}`, changed: true };
    }
    default: {
      const _exhaustive: never = a.type;
      return _exhaustive;
    }
  }
}
