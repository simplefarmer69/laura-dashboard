import { collectMetrics } from "@/lib/grader/sources";
import { computeGrade } from "@/lib/grader/score";
import { loadState, newId, saveState } from "@/lib/store";
import { generateStructured, resolveModel } from "@/lib/swarm/llm";
import { fetchDocsExcerpt } from "@/lib/swarm/context";
import { AGENT_ORDER, SWARM_CHARTER } from "@/lib/swarm/roster";
import {
  briefSchema,
  coachMock,
  coachPrompt,
  coachSystem,
  draftsSchema,
  producerMock,
  producerPrompt,
  producerSystem,
  proposalsSchema,
  scoutMock,
  scoutPrompt,
  type CycleContext,
} from "@/lib/swarm/tasks";
import type {
  Agent,
  CycleRun,
  DailyGrade,
  Draft,
  RunStep,
  StrategyProposal,
  SwarmState,
} from "@/lib/types";

let cycleInFlight: Promise<CycleRun> | null = null;

export function isCycleRunning(): boolean {
  return cycleInFlight !== null;
}

/** Runs the grader only (used by the daily scheduler tick). */
export async function runGrader(): Promise<DailyGrade> {
  const state = await loadState();
  const prev = state.metricsHistory.at(-1) ?? null;
  const metrics = await collectMetrics(state.settings, prev);
  state.metricsHistory.push(metrics);
  const grade = computeGrade(state, metrics);
  upsertGrade(state, grade);
  await saveState(state);
  return grade;
}

function upsertGrade(state: SwarmState, grade: DailyGrade): void {
  const idx = state.grades.findIndex((g) => g.date === grade.date);
  if (idx >= 0) state.grades[idx] = grade;
  else state.grades.push(grade);
}

function agentById(state: SwarmState, id: Agent["id"]): Agent {
  const a = state.agents.find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} missing`);
  return a;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

export function runCycle(trigger: CycleRun["trigger"]): Promise<CycleRun> {
  if (cycleInFlight) return cycleInFlight;
  cycleInFlight = executeCycle(trigger).finally(() => {
    cycleInFlight = null;
  });
  return cycleInFlight;
}

async function executeCycle(trigger: CycleRun["trigger"]): Promise<CycleRun> {
  const state = await loadState();
  const resolved = resolveModel(state.settings.llmModel);
  const run: CycleRun = {
    id: newId("run"),
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    steps: [],
    draftsCreated: 0,
    proposalsCreated: 0,
    llmProvider: resolved.provider === "mock" ? "mock" : `${resolved.provider}/${resolved.modelId}`,
    error: null,
  };
  state.runs.push(run);
  for (const a of state.agents) a.status = "running";
  await saveState(state);

  const step = (s: RunStep) => run.steps.push(s);

  try {
    /* 1. Grader */
    const grader = await timed(async () => {
      const prev = state.metricsHistory.at(-1) ?? null;
      const metrics = await collectMetrics(state.settings, prev);
      state.metricsHistory.push(metrics);
      const grade = computeGrade(state, metrics);
      upsertGrade(state, grade);
      return { metrics, grade };
    });
    step({
      agentId: "grader",
      label: "Collect metrics & grade",
      status: grader.value.metrics.source === "mock" ? "error" : "ok",
      summary: grader.value.grade.summary,
      durationMs: grader.ms,
    });

    const docs = await fetchDocsExcerpt(state.settings);
    const ctx: CycleContext = {
      settings: state.settings,
      metrics: grader.value.metrics,
      grade: grader.value.grade,
      grades: state.grades,
      brief: null,
      docs,
      drafts: state.drafts,
      agents: state.agents,
    };

    /* 2. Scout */
    const scout = agentById(state, "scout");
    const brief = await timed(() =>
      generateStructured(resolved, {
        schema: briefSchema,
        system: `${SWARM_CHARTER}\n\nYour name is ${scout.name}. ${scout.objective}\n\nStrategy (v${scout.strategyVersion}):\n${scout.strategy}`,
        prompt: scoutPrompt(ctx),
        mock: () => scoutMock(ctx),
      }),
    );
    ctx.brief = {
      id: newId("brief"),
      cycleId: run.id,
      createdAt: Date.now(),
      headline: brief.value.value.headline,
      bullets: brief.value.value.bullets,
      sources: [
        `https://api.dexscreener.com/token-pairs/v1/${state.settings.chainSlug}/${state.settings.tokenAddress}`,
        `https://api.llama.fi/summary/fees/${state.settings.llamaSlug}`,
        `${state.settings.projectSite}/docs`,
      ],
    };
    state.researchBriefs.push(ctx.brief);
    state.researchBriefs = state.researchBriefs.slice(-50);
    markRan(scout);
    step({
      agentId: "scout",
      label: "Research brief",
      status: "ok",
      summary: `${brief.value.value.headline}${brief.value.usedMock ? " (fallback)" : ""}`,
      durationMs: brief.ms,
    });
    await saveState(state);

    /* 3. Producers */
    const producers = AGENT_ORDER.filter((id) => id !== "scout" && id !== "coach");
    let budget = state.settings.maxDraftsPerCycle;
    for (const id of producers) {
      const agent = agentById(state, id);
      if (agent.status === "paused") {
        step({ agentId: id, label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
        continue;
      }
      if (budget <= 0) {
        step({ agentId: id, label: "Skipped", status: "skipped", summary: "Draft budget exhausted", durationMs: 0 });
        continue;
      }
      try {
        const out = await timed(() =>
          generateStructured(resolved, {
            schema: draftsSchema,
            system: producerSystem(agent),
            prompt: producerPrompt(agent, ctx),
            mock: () => producerMock(agent, ctx),
          }),
        );
        const accepted = out.value.value.drafts.slice(0, budget);
        budget -= accepted.length;
        for (const d of accepted) {
          const draft: Draft = {
            id: newId("draft"),
            cycleId: run.id,
            agentId: id,
            kind: d.kind,
            channel: d.channel,
            title: d.title,
            body: d.body,
            rationale: d.rationale,
            status: "pending",
            createdAt: Date.now(),
            reviewedAt: null,
            reviewerNote: null,
          };
          state.drafts.push(draft);
          agent.stats.drafts += 1;
          run.draftsCreated += 1;
        }
        markRan(agent);
        step({
          agentId: id,
          label: "Drafts",
          status: "ok",
          summary: `${accepted.length} draft(s): ${accepted.map((d) => d.title).join(" | ")}${out.value.usedMock ? " (fallback)" : ""}`,
          durationMs: out.ms,
        });
      } catch (err) {
        agent.status = "error";
        agent.lastError = String(err);
        step({ agentId: id, label: "Drafts", status: "error", summary: String(err), durationMs: 0 });
      }
      await saveState(state);
    }

    /* 4. Coach */
    const coach = agentById(state, "coach");
    if (coach.status !== "paused") {
      const out = await timed(() =>
        generateStructured(resolved, {
          schema: proposalsSchema,
          system: coachSystem(coach),
          prompt: coachPrompt(ctx),
          mock: () => coachMock(ctx),
        }),
      );
      for (const p of out.value.value.proposals) {
        const target = agentById(state, p.agentId);
        const hasPending = state.proposals.some(
          (x) => x.agentId === target.id && x.status === "pending",
        );
        if (hasPending) continue;
        const proposal: StrategyProposal = {
          id: newId("prop"),
          cycleId: run.id,
          agentId: target.id,
          fromVersion: target.strategyVersion,
          currentStrategy: target.strategy,
          proposedStrategy: p.proposedStrategy,
          rationale: p.rationale,
          evidence: p.evidence,
          status: "pending",
          createdAt: Date.now(),
          reviewedAt: null,
          autoApplied: false,
        };
        state.proposals.push(proposal);
        run.proposalsCreated += 1;
        if (state.settings.autoApplyStrategyProposals) {
          applyProposal(state, proposal, "Auto-applied by coach (operator enabled auto-apply)");
          proposal.autoApplied = true;
        }
      }
      markRan(coach);
      step({
        agentId: "coach",
        label: "Strategy proposals",
        status: "ok",
        summary: `${run.proposalsCreated} proposal(s)${state.settings.autoApplyStrategyProposals ? ", auto-applied" : ", awaiting review"}${out.value.usedMock ? " (fallback)" : ""}`,
        durationMs: out.ms,
      });
    }
  } catch (err) {
    run.error = String(err);
    step({ agentId: "system", label: "Cycle failed", status: "error", summary: String(err), durationMs: 0 });
  } finally {
    for (const a of state.agents) if (a.status === "running") a.status = "idle";
    run.finishedAt = Date.now();
    await saveState(state);
  }
  return run;
}

function markRan(agent: Agent): void {
  agent.stats.runs += 1;
  agent.lastRunAt = Date.now();
  agent.lastError = null;
  agent.status = "idle";
}

export function applyProposal(state: SwarmState, proposal: StrategyProposal, reason: string): void {
  const agent = agentById(state, proposal.agentId);
  agent.history.push({
    version: agent.strategyVersion,
    strategy: agent.strategy,
    adoptedAt: Date.now(),
    reason: `Superseded: ${reason}`,
  });
  agent.strategy = proposal.proposedStrategy;
  agent.strategyVersion += 1;
  proposal.status = "approved";
  proposal.reviewedAt = Date.now();
}
