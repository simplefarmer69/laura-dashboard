import { collectMetrics } from "@/lib/grader/sources";
import { computeGrade } from "@/lib/grader/score";
import { loadState, newId, pushEvent, saveState } from "@/lib/store";
import { checkMilestones } from "@/lib/mission";
import { missionStatus } from "@/lib/mission-status";
import { generateStructured, resolveModel } from "@/lib/swarm/llm";
import { fetchDocsExcerpt, priceTrendDigest, runsDigest } from "@/lib/swarm/context";
import { AGENT_ORDER, NON_PRODUCER_AGENTS } from "@/lib/swarm/roster";
import { applyProposal } from "@/lib/swarm/strategy";
import { checkNovelty } from "@/lib/swarm/novelty";
import {
  agentSystem,
  briefSchema,
  coachMock,
  coachPrompt,
  criticMock,
  criticPrompt,
  criticSchema,
  draftsSchema,
  launchSchema,
  mintMock,
  mintPrompt,
  producerMock,
  producerPrompt,
  proposalsSchema,
  researcherMock,
  researcherPrompt,
  researchSchema,
  scoutMock,
  scoutPrompt,
  spokenLaunchesDigest,
  type CycleContext,
} from "@/lib/swarm/tasks";
import { launcherGrid } from "@/lib/launchpad/service";
import { isDuplicateLaunch } from "@/lib/launchpad/spec";
import { ensureLaunchArt } from "@/lib/launchpad/art";
import { libraryDigest } from "@/lib/swarm/library";
import { AUTO_APPROVE_NOTE } from "@/lib/swarm/autonomy";
import { recordNotes } from "@/lib/swarm/notebook";
import { skillsForAgent } from "@/lib/swarm/skills";
import { coachProposalBudget, mintGate, producerOrder, tuneSettings } from "@/lib/swarm/tuner";
import { utcDate } from "@/lib/grader/score";
import type {
  Agent,
  CycleRun,
  DailyGrade,
  Draft,
  LaunchProposal,
  MetricsSnapshot,
  RunStep,
  StrategyProposal,
  SwarmState,
} from "@/lib/types";

let cycleInFlight: Promise<CycleRun> | null = null;

export function isCycleRunning(): boolean {
  return cycleInFlight !== null;
}

/** Collects metrics, grades, records milestones. Shared by cycles and the daily stamp. */
async function gradeNow(state: SwarmState): Promise<{ metrics: MetricsSnapshot; grade: DailyGrade }> {
  const prev = state.metricsHistory.at(-1) ?? null;
  const metrics = await collectMetrics(state.settings, prev);
  state.metricsHistory.push(metrics);
  const grade = computeGrade(state, metrics);
  const idx = state.grades.findIndex((g) => g.date === grade.date);
  if (idx >= 0) state.grades[idx] = grade;
  else state.grades.push(grade);
  pushEvent(state, {
    kind: "grade.stamped",
    agentId: "grader",
    title: `Grade ${grade.letter} (${grade.score.toFixed(1)}) for ${grade.date}`,
    detail: grade.summary,
    refId: grade.id,
  });
  checkMilestones(state, metrics);
  /* Auto-tune once per UTC day, after the day's first grade stamp. */
  const today = utcDate(metrics.ts);
  if (state.settings.autoTune && state.lastTuneDate !== today) {
    state.lastTuneDate = today;
    tuneSettings(state);
  }
  return { metrics, grade };
}

/** Runs the grader only (used by the daily scheduler tick). */
export async function runGrader(): Promise<DailyGrade> {
  const state = await loadState();
  const { grade } = await gradeNow(state);
  await saveState(state);
  return grade;
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
    llmCalls: 0,
    llmFallbacks: 0,
    llmRepairs: 0,
  };
  state.runs.push(run);
  for (const a of state.agents) if (a.status !== "paused") a.status = "running";
  pushEvent(state, {
    kind: "cycle.started",
    agentId: "system",
    title: `Cycle ${run.id} started (${trigger})`,
    detail: `LLM: ${run.llmProvider}`,
    refId: run.id,
  });
  await saveState(state);

  const step = (s: RunStep) => run.steps.push(s);
  /** Telemetry: every generateStructured result passes through here. */
  const tally = <T extends { usedMock: boolean; repaired: boolean }>(out: T): T => {
    run.llmCalls = (run.llmCalls ?? 0) + 1;
    if (out.usedMock) run.llmFallbacks = (run.llmFallbacks ?? 0) + 1;
    if (out.repaired) run.llmRepairs = (run.llmRepairs ?? 0) + 1;
    return out;
  };

  try {
    /* 1. Grader */
    const grader = await timed(() => gradeNow(state));
    step({
      agentId: "grader",
      label: "Collect metrics & grade",
      status: grader.value.metrics.source === "mock" ? "error" : "ok",
      summary: grader.value.grade.summary,
      durationMs: grader.ms,
    });

    const docs = await fetchDocsExcerpt(state.settings);
    const library = await libraryDigest();
    const skillEntries = await Promise.all(
      state.agents.map(async (a) => [a.id, await skillsForAgent(a.id)] as const),
    );
    const skills = Object.fromEntries(skillEntries);
    const ctx: CycleContext = {
      settings: state.settings,
      metrics: grader.value.metrics,
      grade: grader.value.grade,
      grades: state.grades,
      brief: null,
      docs,
      drafts: state.drafts,
      agents: state.agents,
      lessons: state.lessons,
      mission: missionStatus(state, grader.value.metrics),
      library,
      skills,
      opsHealth: runsDigest(state.runs.filter((r) => r.id !== run.id)),
      priceTrend: priceTrendDigest(state.metricsHistory, grader.value.metrics),
    };

    /* 2. Scout */
    const scout = agentById(state, "scout");
    const brief = await timed(async () =>
      tally(
        await generateStructured(resolved, {
          schema: briefSchema,
          system: agentSystem(scout),
          prompt: scoutPrompt(ctx),
          mock: () => scoutMock(ctx),
        }),
      ),
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
        "https://rpc.mainnet.chain.robinhood.com",
        `${state.settings.projectSite}/docs`,
      ],
    };
    state.researchBriefs.push(ctx.brief);
    state.researchBriefs = state.researchBriefs.slice(-50);
    markRan(scout);
    pushEvent(state, {
      kind: "brief.created",
      agentId: "scout",
      title: brief.value.value.headline,
      detail: brief.value.value.bullets[0] ?? "",
      refId: ctx.brief.id,
    });
    step({
      agentId: "scout",
      label: "Research brief",
      status: "ok",
      summary: `${brief.value.value.headline}${brief.value.usedMock ? " (fallback)" : ""}`,
      durationMs: brief.ms,
    });
    await saveState(state);

    /* 2b. Researcher: one deep-dive per cycle feeding novelty into the notebook.
       Its memo is a "research" draft outside the producer budget — knowledge
       work always runs; only outward-facing content competes for budget. */
    const researcher = agentById(state, "researcher");
    if (researcher.status === "paused") {
      step({ agentId: "researcher", label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
    } else {
      try {
        const out = await timed(async () =>
          tally(
            await generateStructured(resolved, {
              schema: researchSchema,
              system: agentSystem(researcher),
              prompt: researcherPrompt(ctx),
              mock: () => researcherMock(ctx),
            }),
          ),
        );
        const r = out.value.value;
        const memo: Draft = {
          id: newId("draft"),
          cycleId: run.id,
          agentId: "researcher",
          kind: "research",
          channel: "Library",
          title: `Deep-dive: ${r.topic}`,
          body: `${r.memo}\n\n## Angles for the swarm\n${r.anglesForSwarm.map((a) => `- ${a}`).join("\n")}`,
          rationale: r.whyNow,
          status: "pending",
          createdAt: Date.now(),
          reviewedAt: null,
          reviewerNote: null,
        };
        state.drafts.push(memo);
        researcher.stats.drafts += 1;
        run.draftsCreated += 1;
        pushEvent(state, {
          kind: "draft.created",
          agentId: "researcher",
          title: `Scholar deep-dived: ${r.topic}`,
          detail: r.whyNow,
          refId: memo.id,
        });
        for (const rec of await recordNotes(run.id, r.notebook)) {
          pushEvent(state, {
            kind: "note.recorded",
            agentId: "researcher",
            title: `Notebook ${rec.replaced ? "updated" : "entry"}: ${rec.entry.topic}`,
            detail: rec.entry.text,
            refId: rec.entry.id,
          });
        }
        markRan(researcher);
        step({
          agentId: "researcher",
          label: "Deep research",
          status: "ok",
          summary: `${r.topic} · ${r.notebook.length} notebook entr${r.notebook.length === 1 ? "y" : "ies"}${out.value.usedMock ? " (fallback)" : ""}`,
          durationMs: out.ms,
        });
      } catch (err) {
        researcher.status = "error";
        researcher.lastError = String(err);
        step({ agentId: "researcher", label: "Deep research", status: "error", summary: String(err), durationMs: 0 });
        pushEvent(state, { kind: "error", agentId: "researcher", title: "Scholar failed", detail: String(err), refId: run.id });
      }
      await saveState(state);
    }

    /* 3. Producers — ordered by the data: weakest-lever agent first, then by approval rate */
    const weakest = [...ctx.grade.components].sort((a, b) => a.score - b.score)[0];
    const producers = producerOrder(
      state,
      AGENT_ORDER.filter((id) => !NON_PRODUCER_AGENTS.includes(id)),
      weakest.key,
    );
    let budget = state.settings.maxDraftsPerCycle;
    for (const id of producers) {
      const agent = agentById(state, id);
      if (agent.status === "paused") {
        step({ agentId: id, label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
        continue;
      }
      if (budget <= 0) {
        step({ agentId: id, label: "Skipped", status: "skipped", summary: "Draft budget exhausted", durationMs: 0 });
        agent.status = "idle";
        continue;
      }
      try {
        const out = await timed(async () =>
          tally(
            await generateStructured(resolved, {
              schema: draftsSchema,
              system: agentSystem(agent),
              prompt: producerPrompt(agent, ctx),
              mock: () => producerMock(agent, ctx),
            }),
          ),
        );
        const accepted = out.value.value.drafts.slice(0, budget);
        let rejectedForRepetition = 0;
        const autoApprove = state.settings.autoApproveProposals;
        for (const d of accepted) {
          /* Write-time novelty gate: near-duplicates of the agent's recent
             output never land. Rejections are logged so repetition is visible. */
          const novelty = checkNovelty({ agentId: id, kind: d.kind, title: d.title, body: d.body }, state.drafts);
          if (!novelty.ok) {
            rejectedForRepetition += 1;
            pushEvent(state, {
              kind: "novelty.rejected",
              agentId: id,
              title: `Rejected near-duplicate from ${agent.name}: ${d.title}`,
              detail: `${(novelty.score * 100).toFixed(0)}% token overlap with "${novelty.nearest?.title ?? "?"}" (${novelty.nearest ? new Date(novelty.nearest.createdAt).toISOString().slice(0, 10) : "?"})`,
              refId: novelty.nearest?.id ?? null,
            });
            continue;
          }
          budget -= 1;
          const draft: Draft = {
            id: newId("draft"),
            cycleId: run.id,
            agentId: id,
            kind: d.kind,
            channel: d.channel,
            title: d.title,
            body: d.body,
            rationale: d.rationale,
            status: autoApprove ? "approved" : "pending",
            createdAt: Date.now(),
            reviewedAt: autoApprove ? Date.now() : null,
            reviewerNote: autoApprove ? AUTO_APPROVE_NOTE : null,
          };
          state.drafts.push(draft);
          agent.stats.drafts += 1;
          if (autoApprove) agent.stats.approved += 1;
          run.draftsCreated += 1;
          pushEvent(state, {
            kind: "draft.created",
            agentId: id,
            title: `${agent.name} drafted: ${d.title}`,
            detail: `${d.kind} for ${d.channel} · ${d.rationale}`,
            refId: draft.id,
          });
          if (autoApprove) {
            pushEvent(state, {
              kind: "draft.approved",
              agentId: "system",
              title: `Auto-approved: ${d.title}`,
              detail: `${AUTO_APPROVE_NOTE}; publishing stays a separate step.`,
              refId: draft.id,
            });
          }
        }
        markRan(agent);
        step({
          agentId: id,
          label: "Drafts",
          status: "ok",
          summary: `${accepted.length - rejectedForRepetition} draft(s)${rejectedForRepetition > 0 ? `, ${rejectedForRepetition} rejected as near-duplicate` : ""}: ${accepted.map((d) => d.title).join(" | ")}${out.value.usedMock ? " (fallback)" : ""}`,
          durationMs: out.ms,
        });
      } catch (err) {
        agent.status = "error";
        agent.lastError = String(err);
        step({ agentId: id, label: "Drafts", status: "error", summary: String(err), durationMs: 0 });
        pushEvent(state, { kind: "error", agentId: id, title: `${agent.name} failed`, detail: String(err), refId: run.id });
      }
      await saveState(state);
    }

    /* 3b. Critic: red-team pass over this cycle's drafts. Kills repetitive or
       low-quality output before the operator sees it, forcing differentiation
       the lexical novelty gate can't judge. */
    const critic = agentById(state, "critic");
    const cycleDrafts = state.drafts.filter(
      (d) => d.cycleId === run.id && (d.status === "pending" || d.status === "approved"),
    );
    if (critic.status === "paused") {
      step({ agentId: "critic", label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
    } else if (cycleDrafts.length === 0) {
      step({ agentId: "critic", label: "Red-team review", status: "skipped", summary: "No drafts to review this cycle", durationMs: 0 });
    } else {
      try {
        const out = await timed(async () =>
          tally(
            await generateStructured(resolved, {
              schema: criticSchema,
              system: agentSystem(critic),
              prompt: criticPrompt(ctx, cycleDrafts),
              mock: () => criticMock(cycleDrafts),
            }),
          ),
        );
        let vetoes = 0;
        for (const review of out.value.value.reviews) {
          if (review.verdict !== "veto") continue;
          const draft = cycleDrafts.find((d) => d.id === review.draftId);
          if (!draft) continue;
          const wasApproved = draft.status === "approved";
          draft.status = "rejected";
          draft.reviewedAt = Date.now();
          draft.reviewerNote = `Critic veto: ${review.reason}`;
          const author = state.agents.find((a) => a.id === draft.agentId);
          if (author) {
            author.stats.rejected += 1;
            if (wasApproved && author.stats.approved > 0) author.stats.approved -= 1;
          }
          vetoes += 1;
          pushEvent(state, {
            kind: "critic.vetoed",
            agentId: "critic",
            title: `Auditor vetoed: ${draft.title}`,
            detail: review.reason,
            refId: draft.id,
          });
        }
        if (out.value.value.observation && !out.value.usedMock) {
          for (const rec of await recordNotes(run.id, [
            { topic: "Critic observation", text: out.value.value.observation },
          ])) {
            pushEvent(state, {
              kind: "note.recorded",
              agentId: "critic",
              title: `Notebook ${rec.replaced ? "updated" : "entry"}: ${rec.entry.topic}`,
              detail: rec.entry.text,
              refId: rec.entry.id,
            });
          }
        }
        markRan(critic);
        step({
          agentId: "critic",
          label: "Red-team review",
          status: "ok",
          summary: `${cycleDrafts.length} reviewed, ${vetoes} vetoed${out.value.usedMock ? " (fallback: all passed)" : ""} · ${out.value.value.observation.slice(0, 160)}`,
          durationMs: out.ms,
        });
      } catch (err) {
        critic.status = "error";
        critic.lastError = String(err);
        step({ agentId: "critic", label: "Red-team review", status: "error", summary: String(err), durationMs: 0 });
        pushEvent(state, { kind: "error", agentId: "critic", title: "Auditor failed", detail: String(err), refId: run.id });
      }
      await saveState(state);
    }

    /* 4. Mint: launchpad specs */
    const mint = agentById(state, "mint");
    const gate = mintGate(state);
    if (mint.status === "paused") {
      step({ agentId: "mint", label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
    } else if (gate.blocked) {
      step({ agentId: "mint", label: "Launch spec", status: "skipped", summary: gate.reason, durationMs: 0 });
    } else {
      try {
        let floor = "Launcher floor data unavailable this cycle.";
        try {
          const grid = await launcherGrid("new", 10);
          floor = grid
            .map(
              (t) =>
                `- ${t.name} ($${t.symbol}): mcap $${Math.round(t.mcapUsd).toLocaleString()}, curve ${t.curvePct.toFixed(1)}%, ${t.holderCount} holders${t.graduated ? ", graduated" : ""}`,
            )
            .join("\n");
        } catch {
          /* floor context is optional */
        }
        const pending = state.launches.filter((l) => l.status === "pending" || l.status === "approved").length;
        const spoken = spokenLaunchesDigest(state.launches);
        const out = await timed(async () =>
          tally(
            await generateStructured(resolved, {
              schema: launchSchema,
              system: agentSystem(mint),
              prompt: mintPrompt(ctx, floor, pending, spoken),
              mock: () => mintMock(ctx, pending),
            }),
          ),
        );
        let spec = out.value.value.launch;
        let skipReason = out.value.value.skipReason ?? "No launch this cycle";
        /* Never queue a concept that duplicates an existing non-rejected launch. */
        if (spec) {
          if (isDuplicateLaunch(state.launches, spec.name, spec.symbol)) {
            skipReason = `Dropped duplicate concept: ${spec.name} ($${spec.symbol}) already exists in the queue or on-chain`;
            spec = null;
          }
        }
        if (spec) {
          const autonomous = state.settings.autoExecuteLaunches || state.settings.autoApproveProposals;
          const launch: LaunchProposal = {
            id: newId("launch"),
            cycleId: run.id,
            createdAt: Date.now(),
            lane: "weth",
            name: spec.name,
            symbol: spec.symbol,
            supplyTokens: spec.supplyTokens,
            startMcapUsd: spec.startMcapUsd,
            gradMcapUsd: spec.gradMcapUsd,
            startTaxBps: spec.startTaxBps,
            taxDecayPerMinuteBps: spec.taxDecayPerMinuteBps,
            postTaxBps: spec.postTaxBps,
            sellsEnabled: spec.sellsEnabled,
            bufferSecs: spec.bufferSecs,
            concept: spec.concept,
            rationale: spec.rationale,
            message: spec.message,
            artMotif: spec.artMotif,
            artPalette: spec.artPalette,
            status: autonomous ? "approved" : "pending",
            reviewedAt: autonomous ? Date.now() : null,
            reviewerNote: autonomous ? "Auto-approved: operator granted full launch autonomy" : null,
            txHash: null,
            tokenAddress: null,
            launchId: null,
            deployedAt: null,
            error: null,
            imageHash: null,
          };
          state.launches.push(launch);
          mint.stats.drafts += 1;
          if (autonomous) mint.stats.approved += 1;
          pushEvent(state, {
            kind: "launch.proposed",
            agentId: "mint",
            title: `Mint designed launch: ${spec.name} ($${spec.symbol})`,
            detail: spec.message ? `LAURA says: "${spec.message}" · ${spec.concept}` : spec.concept,
            refId: launch.id,
          });
          if (autonomous) {
            pushEvent(state, {
              kind: "launch.approved",
              agentId: "system",
              title: `Auto-approved ${spec.name} ($${spec.symbol})`,
              detail: "Full launch autonomy is on; deploys when the wallet is funded, within hard caps.",
              refId: launch.id,
            });
          }
          try {
            await ensureLaunchArt(launch.id, {
              name: launch.name,
              symbol: launch.symbol,
              motif: launch.artMotif,
              palette: launch.artPalette,
            });
          } catch {
            /* art regenerates on demand at deploy time */
          }
          step({
            agentId: "mint",
            label: "Launch spec",
            status: "ok",
            summary: `${spec.name} ($${spec.symbol}) start $${spec.startMcapUsd.toLocaleString()} -> grad $${spec.gradMcapUsd.toLocaleString()}${out.value.usedMock ? " (fallback)" : ""}`,
            durationMs: out.ms,
          });
        } else {
          step({
            agentId: "mint",
            label: "Launch spec",
            status: "skipped",
            summary: skipReason,
            durationMs: out.ms,
          });
        }
        markRan(mint);
      } catch (err) {
        mint.status = "error";
        mint.lastError = String(err);
        step({ agentId: "mint", label: "Launch spec", status: "error", summary: String(err), durationMs: 0 });
        pushEvent(state, { kind: "error", agentId: "mint", title: "Mint failed", detail: String(err), refId: run.id });
      }
      await saveState(state);
    }

    /* 5. Coach: lessons + proposals */
    const coach = agentById(state, "coach");
    if (coach.status !== "paused") {
      const out = await timed(async () =>
        tally(
          await generateStructured(resolved, {
            schema: proposalsSchema,
            system: agentSystem(coach),
            prompt: coachPrompt(ctx),
            mock: () => coachMock(ctx),
          }),
        ),
      );
      for (const l of out.value.value.lessons) {
        const duplicate = state.lessons.some((x) => x.text.trim().toLowerCase() === l.text.trim().toLowerCase());
        if (duplicate) continue;
        const lesson = { id: newId("lesson"), ts: Date.now(), cycleId: run.id, text: l.text, evidence: l.evidence };
        state.lessons.push(lesson);
        pushEvent(state, { kind: "lesson.learned", agentId: "coach", title: l.text, detail: l.evidence, refId: lesson.id });
      }
      for (const rec of await recordNotes(run.id, out.value.value.notebook ?? [])) {
        pushEvent(state, {
          kind: "note.recorded",
          agentId: "coach",
          title: `Notebook ${rec.replaced ? "updated" : "entry"}: ${rec.entry.topic}`,
          detail: rec.entry.text,
          refId: rec.entry.id,
        });
      }
      const proposalBudget = coachProposalBudget(state);
      for (const p of out.value.value.proposals.slice(0, proposalBudget)) {
        const target = agentById(state, p.agentId);
        const hasPending = state.proposals.some((x) => x.agentId === target.id && x.status === "pending");
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
        pushEvent(state, {
          kind: "proposal.created",
          agentId: "coach",
          title: `Coach proposed v${target.strategyVersion + 1} for ${target.name}`,
          detail: p.rationale,
          refId: proposal.id,
        });
        if (state.settings.autoApplyStrategyProposals || state.settings.autoApproveProposals) {
          applyProposal(
            state,
            proposal,
            state.settings.autoApproveProposals ? AUTO_APPROVE_NOTE : "Auto-applied by coach (operator enabled auto-apply)",
            "coach",
          );
          proposal.autoApplied = true;
        }
      }
      markRan(coach);
      step({
        agentId: "coach",
        label: "Lessons & proposals",
        status: "ok",
        summary: `${out.value.value.lessons.length} lesson(s), ${run.proposalsCreated} proposal(s)${state.settings.autoApplyStrategyProposals || state.settings.autoApproveProposals ? " auto-applied" : " awaiting review"}${out.value.usedMock ? " (fallback)" : ""}`,
        durationMs: out.ms,
      });
    }
  } catch (err) {
    run.error = String(err);
    step({ agentId: "system", label: "Cycle failed", status: "error", summary: String(err), durationMs: 0 });
    pushEvent(state, { kind: "error", agentId: "system", title: "Cycle failed", detail: String(err), refId: run.id });
  } finally {
    for (const a of state.agents) if (a.status === "running") a.status = "idle";
    run.finishedAt = Date.now();
    pushEvent(state, {
      kind: "cycle.finished",
      agentId: "system",
      title: `Cycle ${run.id} finished: ${run.draftsCreated} drafts, ${run.proposalsCreated} proposals`,
      detail: `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s${run.error ? ` · ${run.error}` : ""}`,
      refId: run.id,
    });
    /* Watchdog: two consecutive failed cycles is a systemic problem, not a
       blip. Derived from recorded runs (survives restarts) and covers every
       trigger — scheduler, event and manual. */
    const finished = state.runs.filter((r) => r.finishedAt !== null);
    const streak = finished.length - 1 - finished.findLastIndex((r) => !r.error);
    if (run.error && streak >= 2) {
      pushEvent(state, {
        kind: "swarm.health",
        agentId: "system",
        title: `Swarm health: ${streak} consecutive cycle failures`,
        detail: `Latest: ${run.error}. Check LLM provider, upstream APIs and dev-server logs.`,
        refId: run.id,
      });
    }
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
