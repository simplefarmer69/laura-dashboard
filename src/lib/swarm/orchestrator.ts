import { collectMetrics } from "@/lib/grader/sources";
import { computeGrade } from "@/lib/grader/score";
import { loadState, newId, pushEvent, saveState } from "@/lib/store";
import { checkMilestones } from "@/lib/mission";
import { missionStatus } from "@/lib/mission-status";
import { generateStructured, resolveModel } from "@/lib/swarm/llm";
import { fetchDocsExcerpt, priceTrendDigest, recentOutputDigest, reviewerFeedback, runsDigest } from "@/lib/swarm/context";
import { collectIntel, intelDigest } from "@/lib/swarm/intel";
import { worldContext } from "@/lib/swarm/worldfeeds";
import { forumDigest } from "@/lib/swarm/forum";
import { collectOnchainDigest } from "@/lib/swarm/onchain";
import { laneMenuDigest, recentLaunchLanes, resolveLane } from "@/lib/launchpad/lanes";
import { AGENT_ORDER, NON_PRODUCER_AGENTS } from "@/lib/swarm/roster";
import { applyProposal } from "@/lib/swarm/strategy";
import { checkNovelty } from "@/lib/swarm/novelty";
import {
  agentSystem,
  briefSchema,
  builderMock,
  builderPrompt,
  builderSchema,
  chainReadSchema,
  coachMock,
  coachPrompt,
  criticMock,
  criticPrompt,
  criticSchema,
  draftsSchema,
  launchSchema,
  mintMock,
  mintPrompt,
  padOutcomeStudy,
  producerMock,
  producerPrompt,
  proposalsSchema,
  researcherMock,
  researcherPrompt,
  researchSchema,
  SAGE_LEDGER_FILE,
  sageAuditTarget,
  sageMock,
  sagePassForRun,
  sagePrompt,
  sageSchema,
  scoutMock,
  scoutPrompt,
  spokenLaunchesDigest,
  vaultMock,
  vaultPrompt,
  vaultSchema,
  watcherMock,
  watcherPrompt,
  type CycleContext,
  type SageInputs,
} from "@/lib/swarm/tasks";
import { launcherGrid } from "@/lib/launchpad/service";
import { launchCapacityDigest } from "@/lib/launchpad/treasury";
import { isDuplicateLaunch, reservedLaunchNameHit } from "@/lib/launchpad/spec";
import { ensureLaunchArt } from "@/lib/launchpad/art";
import { libraryDigest, libraryDocText, libraryFileIndex, writeLibraryDoc } from "@/lib/swarm/library";
import { AUTO_APPROVE_NOTE } from "@/lib/swarm/autonomy";
import { recordNotes } from "@/lib/swarm/notebook";
import { skillsForAgent, writeSkill } from "@/lib/swarm/skills";
import { coachProposalBudget, mintGate, mintQueueLimit, producerOrder, tuneSettings } from "@/lib/swarm/tuner";
import { builderGate } from "@/lib/builder/caps";
import {
  builderCandidates,
  builderCandidatesDigest,
  builderCapacityDigest,
  utilityProjectsDigest,
} from "@/lib/builder/executor";
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
  UtilityProject,
} from "@/lib/types";

/* On globalThis, not module scope: under dev HMR every compile gets its own
   module copy, and two copies (e.g. the scheduler loop and a manual /api/cycle
   request) each saw a null module-level guard and ran cycles concurrently
   (run_6220e642, 2026-09-11). One process, one cycle, whichever module runs it. */
declare global {
  var __lauraCycleInFlight: Promise<CycleRun> | null | undefined;
}

export function isCycleRunning(): boolean {
  return (globalThis.__lauraCycleInFlight ?? null) !== null;
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
  const inFlight = globalThis.__lauraCycleInFlight ?? null;
  if (inFlight) return inFlight;
  const p = executeCycle(trigger).finally(() => {
    globalThis.__lauraCycleInFlight = null;
  });
  globalThis.__lauraCycleInFlight = p;
  return p;
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

    /* 1b. Live internet intel: real reads (X search/timelines, CoinGecko,
       Blockscout) so every agent reasons from today's world. Non-fatal by
       construction — collectIntel settles each source independently. */
    let intelText = "Live internet intel unavailable this cycle.";
    try {
      const intel = await timed(() =>
        collectIntel(state.settings, state.intelHistory?.at(-1) ?? null),
      );
      state.intelHistory = [...(state.intelHistory ?? []), intel.value];
      intelText = intelDigest(intel.value, state.intelHistory);
      const snap = intel.value;
      /* Founder catalyst hits are the operator's #1 priority — surface each
         once as a first-class event (deduped by tweet id via refId). */
      for (const hit of snap.x?.catalysts ?? []) {
        const refId = `xcat_${hit.id}`;
        if (state.events.some((e) => e.refId === refId)) continue;
        pushEvent(state, {
          kind: "intel.catalyst",
          agentId: "system",
          title: `PRIORITY CATALYST: @${hit.author} engaged operator accounts / stock tokens`,
          detail: `"${hit.text}" (${hit.likes} likes, ${hit.retweets} RTs) — operator playbook: amplify immediately across all channels.`,
          refId,
        });
      }
      step({
        agentId: "system",
        label: "Internet intel",
        status: snap.sources.length > 0 ? "ok" : "error",
        summary: `sources: ${snap.sources.join(", ") || "none"}${snap.x ? ` · ${snap.x.mentionCount24h} X mentions/24h, ${snap.x.engagement24h} engagements` : ""}${snap.warnings.length ? ` · ${snap.warnings.length} warning(s): ${snap.warnings.join("; ").slice(0, 200)}` : ""}`,
        durationMs: intel.ms,
      });
    } catch (err) {
      step({ agentId: "system", label: "Internet intel", status: "error", summary: String(err), durationMs: 0 });
    }
    await saveState(state);

    /* 1c. On-chain digest: deterministic reads of LAURA's own footprint
       (treasury, caps, LP, earnings from state + live pool/floor reads).
       Non-fatal by construction; Watcher interprets it right after. */
    let onchainText = "On-chain digest unavailable this cycle.";
    try {
      const ethUsd =
        grader.value.metrics.onchain?.ethPriceUsd ?? state.intelHistory?.at(-1)?.ethUsd ?? null;
      const oc = await timed(() => collectOnchainDigest(state, ethUsd));
      onchainText = oc.value.digest;
      step({
        agentId: "system",
        label: "On-chain digest",
        status: oc.value.warnings.length === 0 ? "ok" : "error",
        summary: `${onchainText.split("\n")[0]?.slice(0, 160) ?? ""}${oc.value.warnings.length ? ` · ${oc.value.warnings.length} warning(s)` : ""}`,
        durationMs: oc.ms,
      });
    } catch (err) {
      step({ agentId: "system", label: "On-chain digest", status: "error", summary: String(err), durationMs: 0 });
    }

    /* 1c2. World feeds: Polymarket odds, ESPN scores, launcher tape,
       protocol economics and community chatter for ideation. Fail-soft by
       construction — worldContext settles each source independently. */
    let worldText = "World feeds unavailable this cycle.";
    try {
      const world = await timed(() => worldContext());
      worldText = world.value;
      step({
        agentId: "system",
        label: "World feeds",
        status: worldText.startsWith("World feeds unavailable") ? "error" : "ok",
        summary: worldText.split("\n")[0]?.slice(0, 160) ?? "",
        durationMs: world.ms,
      });
    } catch (err) {
      step({ agentId: "system", label: "World feeds", status: "error", summary: String(err), durationMs: 0 });
    }

    /* 1c3. The Cafe Bar: fold the swarm's own forum into world context so
       token ideation can pick up themes the agents are already debating. */
    const cafe = forumDigest(state.forum ?? []);
    if (!cafe.startsWith("The bar is empty")) {
      worldText = `${worldText}\n\nTHE CAFE BAR (the swarm's own forum — live agent debate; mine it for token themes)\n${cafe.slice(0, 1400)}`;
    }

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
      intel: intelText,
      world: worldText,
      onchain: onchainText,
      cycleSeq: state.runs.length,
    };

    /* 1d. Watcher: interprets the on-chain digest into a headline + alerts
       that every downstream prompt receives via ctx.onchain. Runs before the
       scout so the whole cycle reasons from live chain state. */
    const watcher = agentById(state, "watcher");
    if (watcher.status === "paused") {
      step({ agentId: "watcher", label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
    } else {
      try {
        const out = await timed(async () =>
          tally(
            await generateStructured(resolved, {
              schema: chainReadSchema,
              system: agentSystem(watcher),
              prompt: watcherPrompt(ctx),
              mock: () => watcherMock(ctx),
            }),
          ),
        );
        const read = out.value.value;
        ctx.onchain = `${onchainText}\n\nWatcher's read this cycle:\n${read.headline}\n${read.alerts.map((a) => `- ${a}`).join("\n")}`;
        pushEvent(state, {
          kind: "onchain.observed",
          agentId: "watcher",
          title: read.headline,
          detail: read.alerts.join(" · "),
          refId: run.id,
        });
        if (read.notebook && !out.value.usedMock) {
          for (const rec of await recordNotes(run.id, [read.notebook])) {
            pushEvent(state, {
              kind: "note.recorded",
              agentId: "watcher",
              title: `Notebook ${rec.replaced ? "updated" : "entry"}: ${rec.entry.topic}`,
              detail: rec.entry.text,
              refId: rec.entry.id,
            });
          }
        }
        markRan(watcher);
        step({
          agentId: "watcher",
          label: "On-chain read",
          status: "ok",
          summary: `${read.headline}${out.value.usedMock ? " (fallback)" : ""}`,
          durationMs: out.ms,
        });
      } catch (err) {
        watcher.status = "error";
        watcher.lastError = String(err);
        step({ agentId: "watcher", label: "On-chain read", status: "error", summary: String(err), durationMs: 0 });
        pushEvent(state, { kind: "error", agentId: "watcher", title: "Watcher failed", detail: String(err), refId: run.id });
      }
      await saveState(state);
    }

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
        "https://api.x.com/2/tweets/search/recent (read-only bearer)",
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
          title: `Deep-dive: ${r.topic.replace(/^deep-dive:\s*/i, "")}`,
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

    /* 3a. Vault: treasury strategy memo + capped-action recommendations.
       Runs on a stride (~every 2nd cycle at base cadence) because treasury
       state moves on 6h buy gaps, not 75-minute cycles — this keeps the
       per-cycle LLM call count flat most cycles. Its memo is a "report"
       draft, so the critic reviews it below like everything else; execution
       stays exclusively in the capped scheduler/executor paths. */
    const vault = agentById(state, "vault");
    const vaultStrideMs = 1.5 * state.settings.cycleIntervalMinutes * 60_000;
    if (vault.status === "paused") {
      step({ agentId: "vault", label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
    } else if (vault.lastRunAt !== null && Date.now() - vault.lastRunAt < vaultStrideMs) {
      step({
        agentId: "vault",
        label: "Treasury memo",
        status: "skipped",
        summary: `Stride: last memo ${((Date.now() - vault.lastRunAt) / 60_000).toFixed(0)}m ago (< ${Math.round(vaultStrideMs / 60_000)}m) — treasury state moves slower than the cycle cadence`,
        durationMs: 0,
      });
    } else {
      try {
        const out = await timed(async () =>
          tally(
            await generateStructured(resolved, {
              schema: vaultSchema,
              system: agentSystem(vault),
              prompt: vaultPrompt(ctx),
              mock: () => vaultMock(ctx),
            }),
          ),
        );
        const v = out.value.value;
        const autoApprove = state.settings.autoApproveProposals;
        const memo: Draft = {
          id: newId("draft"),
          cycleId: run.id,
          agentId: "vault",
          kind: "report",
          channel: "Treasury",
          title: `Treasury strategy — ${ctx.grade.date}`,
          body: `${v.memo}\n\n## Recommendations (proposals only — execution stays in the capped autonomous paths)\n${v.recommendations.map((r) => `- **${r.action}**: ${r.detail}\n  Trigger: ${r.trigger}`).join("\n")}`,
          rationale: v.rationale,
          status: autoApprove ? "approved" : "pending",
          createdAt: Date.now(),
          reviewedAt: autoApprove ? Date.now() : null,
          reviewerNote: autoApprove ? AUTO_APPROVE_NOTE : null,
        };
        state.drafts.push(memo);
        vault.stats.drafts += 1;
        if (autoApprove) vault.stats.approved += 1;
        run.draftsCreated += 1;
        pushEvent(state, {
          kind: "draft.created",
          agentId: "vault",
          title: `Vault drafted: ${memo.title}`,
          detail: `report for Treasury · ${v.rationale}`,
          refId: memo.id,
        });
        for (const r of v.recommendations) {
          pushEvent(state, {
            kind: "treasury.proposed",
            agentId: "vault",
            title: `Vault proposes: ${r.action}`,
            detail: `${r.detail} · Trigger: ${r.trigger}`,
            refId: memo.id,
          });
        }
        markRan(vault);
        step({
          agentId: "vault",
          label: "Treasury memo",
          status: "ok",
          summary: `${v.recommendations.map((r) => r.action).join(", ")}${out.value.usedMock ? " (fallback)" : ""}`,
          durationMs: out.ms,
        });
      } catch (err) {
        vault.status = "error";
        vault.lastError = String(err);
        step({ agentId: "vault", label: "Treasury memo", status: "error", summary: String(err), durationMs: 0 });
        pushEvent(state, { kind: "error", agentId: "vault", title: "Vault failed", detail: String(err), refId: run.id });
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
          /* Wide sample: the newest 10 render as live floor lines; all 60 feed
             the outcome study so Mint learns from graduations and corpses
             across every creator, not just the current page. */
          const grid = await launcherGrid("new", 60);
          const lines = grid
            .slice(0, 10)
            .map(
              (t) =>
                `- ${t.name} ($${t.symbol}): mcap $${Math.round(t.mcapUsd).toLocaleString()}, curve ${t.curvePct.toFixed(1)}%, ${t.holderCount} holders${t.graduated ? ", graduated" : ""}`,
            )
            .join("\n");
          floor = `${lines}\n\nPAD OUTCOME STUDY\n${padOutcomeStudy(grid)}`;
        } catch {
          /* floor context is optional */
        }
        const pending = state.launches.filter((l) => l.status === "pending" || l.status === "approved").length;
        const spoken = spokenLaunchesDigest(state.launches);
        const capacity = launchCapacityDigest(state);
        const laneMenu = laneMenuDigest(new Date(), state.runs.length, recentLaunchLanes(state.launches));
        const queueLimit = mintQueueLimit(state.settings);
        const out = await timed(async () =>
          tally(
            await generateStructured(resolved, {
              schema: launchSchema,
              system: agentSystem(mint),
              prompt: mintPrompt(ctx, floor, pending, spoken, capacity, laneMenu, queueLimit),
              mock: () => mintMock(ctx, pending, queueLimit),
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
        /* Never queue a name the Stonklauncher floor hides: it would deploy,
           cost the fee, and then be invisible on the site and in Telegram. */
        if (spec) {
          const hit = reservedLaunchNameHit(spec.name, spec.symbol);
          if (hit) {
            skipReason = `Dropped reserved name: ${spec.name} ($${spec.symbol}) contains "${hit}", which the launcher floor hides`;
            spec = null;
          }
        }
        if (spec) {
          const autonomous = state.settings.autoExecuteLaunches || state.settings.autoApproveProposals;
          const launch: LaunchProposal = {
            id: newId("launch"),
            cycleId: run.id,
            createdAt: Date.now(),
            /* Weekend-closed stock picks resolve to an open crypto lane here;
               unknown lanes fall back to the cycle rotation hint. */
            lane: resolveLane(spec.lane, new Date(), state.runs.length),
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
            openEnded: spec.openEnded,
            eoaOnly: spec.eoaOnly,
            maxBuyPpm: spec.maxBuyPpm,
            bondVenue: spec.bondVenue,
            unsoldMode: spec.unsoldMode,
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

    /* 4b. Builder: utility projects for LAURA's launched tokens (strided;
       runs about every third cycle so builds stay curated, never automatic). */
    const builder = agentById(state, "builder");
    const builderStrideMs = 3 * Math.max(30, state.settings.cycleIntervalMinutes) * 60_000;
    const builderDue = (builder.lastRunAt ?? 0) <= Date.now() - builderStrideMs;
    const builderBlocked = builderGate(state);
    if (builder.status === "paused") {
      step({ agentId: "builder", label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
    } else if (!builderDue) {
      step({
        agentId: "builder",
        label: "Utility build",
        status: "skipped",
        summary: "Strided: the builder designs at most one project about every third cycle",
        durationMs: 0,
      });
    } else if (builderBlocked.blocked) {
      step({ agentId: "builder", label: "Utility build", status: "skipped", summary: builderBlocked.reason, durationMs: 0 });
    } else {
      try {
        const candidates = builderCandidates(state);
        if (candidates.length === 0) {
          markRan(builder);
          step({
            agentId: "builder",
            label: "Utility build",
            status: "skipped",
            summary: "No eligible tokens yet (deployed, 24h+ old, not already served)",
            durationMs: 0,
          });
        } else {
          const out = await timed(async () =>
            tally(
              await generateStructured(resolved, {
                schema: builderSchema,
                system: agentSystem(builder),
                prompt: builderPrompt(
                  ctx,
                  builderCandidatesDigest(state),
                  utilityProjectsDigest(state),
                  builderCapacityDigest(state),
                ),
                mock: () => builderMock(),
              }),
            ),
          );
          const projOut = out.value.value.project;
          let skipReason = out.value.value.skipReason ?? "No utility build this cycle";
          const tokenAddr = projOut ? projOut.tokenAddress.toLowerCase() : null;
          const match = tokenAddr ? candidates.find((c) => c.tokenAddress === tokenAddr) : undefined;
          if (projOut && !match) {
            skipReason = `Dropped: ${projOut.tokenAddress} is not an eligible LAURA-launched token`;
          }
          if (projOut && match) {
            const autonomous = state.settings.autoApproveProposals;
            const project: UtilityProject = {
              id: newId("utility"),
              cycleId: run.id,
              createdAt: Date.now(),
              tokenAddress: match.tokenAddress,
              tokenSymbol: match.symbol,
              launchProposalId: match.proposal.id,
              kind: projOut.kind,
              title: projOut.title,
              concept: projOut.concept,
              utility: projOut.utility,
              rationale: projOut.rationale,
              /* Faucets cannot ship without a bag; force the flag on for them. */
              wantsAcquisition: projOut.kind === "faucet-drip" ? true : projOut.wantsAcquisition,
              faucetClaimTokens: projOut.faucetClaimTokens,
              faucetIntervalHours: projOut.faucetIntervalHours,
              status: autonomous ? "approved" : "pending",
              reviewedAt: autonomous ? Date.now() : null,
              reviewerNote: autonomous ? AUTO_APPROVE_NOTE : null,
              acquisition: null,
              deploy: null,
              shippedAt: null,
              error: null,
            };
            state.utilityProjects = [...(state.utilityProjects ?? []), project];
            builder.stats.drafts += 1;
            if (autonomous) builder.stats.approved += 1;
            pushEvent(state, {
              kind: "utility.proposed",
              agentId: "builder",
              title: `Builder designed ${projOut.kind} for $${match.symbol}: ${projOut.title}`,
              detail: `${projOut.utility} ${projOut.concept}`,
              refId: project.id,
            });
            if (autonomous) {
              pushEvent(state, {
                kind: "utility.approved",
                agentId: "system",
                title: `Auto-approved utility build for $${match.symbol}`,
                detail: `${AUTO_APPROVE_NOTE}; executes only while autoExecuteUtility is on, within BUILDER_CAPS.`,
                refId: project.id,
              });
            }
            step({
              agentId: "builder",
              label: "Utility build",
              status: "ok",
              summary: `${projOut.kind} for $${match.symbol}: ${projOut.title}${out.value.usedMock ? " (fallback)" : ""}`,
              durationMs: out.ms,
            });
          } else {
            step({ agentId: "builder", label: "Utility build", status: "skipped", summary: skipReason, durationMs: out.ms });
          }
          markRan(builder);
        }
      } catch (err) {
        builder.status = "error";
        builder.lastError = String(err);
        step({ agentId: "builder", label: "Utility build", status: "error", summary: String(err), durationMs: 0 });
        pushEvent(state, { kind: "error", agentId: "builder", title: "Builder failed", detail: String(err), refId: run.id });
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
      /* Skill self-editing: one file per cycle, constrained to /library/skills
         by writeSkill (slugged filename, dir-escape check, file-count cap).
         Failure is recorded, never fatal to the cycle. */
      const skillEdit = out.value.value.skillEdit;
      if (skillEdit) {
        try {
          const res = await writeSkill({
            name: skillEdit.name,
            description: skillEdit.description,
            agents: skillEdit.agents,
            body: skillEdit.body,
          });
          pushEvent(state, {
            kind: "skill.updated",
            agentId: "coach",
            title: `Skill ${res.created ? "created" : "updated"}: ${skillEdit.name}`,
            detail: `${skillEdit.rationale} (file ${res.file}; applies to ${skillEdit.agents.join(", ")})`,
            refId: run.id,
          });
        } catch (err) {
          pushEvent(state, {
            kind: "error",
            agentId: "coach",
            title: `Skill edit rejected: ${skillEdit.name}`,
            detail: String(err),
            refId: run.id,
          });
        }
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

    /* 6. Sage: the collective intelligence pass. Strided at 2x the cycle
       cadence (at most one extra LLM call every other cycle) and exactly ONE
       call when it runs. It runs last so the pass sees the finished cycle,
       and its writes flow only through the allowlisted channels: the library
       write path (operator docs denied in code), the coach's writeSkill
       machinery, and the notebook. Never code, caps, guards or executors. */
    const sage = agentById(state, "sage");
    const sageStrideMs = 2 * state.settings.cycleIntervalMinutes * 60_000;
    if (sage.status === "paused") {
      step({ agentId: "sage", label: "Paused", status: "skipped", summary: "Agent paused by operator", durationMs: 0 });
    } else if (sage.lastRunAt !== null && Date.now() - sage.lastRunAt < sageStrideMs) {
      step({
        agentId: "sage",
        label: "Collective intelligence",
        status: "skipped",
        summary: `Stride: last pass ${((Date.now() - sage.lastRunAt) / 60_000).toFixed(0)}m ago (< ${Math.round(sageStrideMs / 60_000)}m); shared context compounds on a slower clock than the cycle`,
        durationMs: 0,
      });
    } else {
      try {
        const pass = sagePassForRun(sage.stats.runs);
        const auditAgent = pass === "audit" ? sageAuditTarget(state.agents, sage.stats.runs) : null;
        const frictions =
          state.events
            .filter(
              (e) =>
                e.kind === "novelty.rejected" ||
                e.kind === "critic.vetoed" ||
                e.kind === "swarm.health" ||
                e.kind === "error",
            )
            .slice(-12)
            .map((e) => `- [${e.kind}] ${e.title}: ${e.detail.slice(0, 200)}`)
            .join("\n") || "No recent frictions recorded.";
        const inputs: SageInputs = {
          pass,
          ledger: await libraryDocText(SAGE_LEDGER_FILE),
          frictions,
          forum: cafe,
          audit: auditAgent
            ? {
                agent: auditAgent,
                recentOutput: recentOutputDigest(state.drafts, auditAgent.id, 6),
                feedback: reviewerFeedback(state.drafts, auditAgent.id, 6),
              }
            : null,
          libraryIndex: await libraryFileIndex(),
        };
        const out = await timed(async () =>
          tally(
            await generateStructured(resolved, {
              schema: sageSchema,
              system: agentSystem(sage),
              prompt: sagePrompt(ctx, inputs),
              mock: () => sageMock(inputs),
            }),
          ),
        );
        const s = out.value.value;
        const writes: string[] = [];
        /* The pass memo lands as a research draft so the console shows the finding. */
        const autoApprove = state.settings.autoApproveProposals;
        const memo: Draft = {
          id: newId("draft"),
          cycleId: run.id,
          agentId: "sage",
          kind: "research",
          channel: "Library",
          title: s.title,
          body: s.insight,
          rationale: `Collective intelligence pass (${pass}): shared context every agent receives through the digest.`,
          status: autoApprove ? "approved" : "pending",
          createdAt: Date.now(),
          reviewedAt: autoApprove ? Date.now() : null,
          reviewerNote: autoApprove ? AUTO_APPROVE_NOTE : null,
        };
        state.drafts.push(memo);
        sage.stats.drafts += 1;
        if (autoApprove) sage.stats.approved += 1;
        run.draftsCreated += 1;
        pushEvent(state, {
          kind: "draft.created",
          agentId: "sage",
          title: `Sage (${pass} pass): ${s.title}`,
          detail: s.insight.slice(0, 200),
          refId: memo.id,
        });
        if (s.libraryEdit && !out.value.usedMock) {
          try {
            const res = await writeLibraryDoc({ file: s.libraryEdit.file, body: s.libraryEdit.body });
            writes.push(`library/${res.file} ${res.created ? "created" : "updated"}`);
            pushEvent(state, {
              kind: "library.updated",
              agentId: "sage",
              title: `Library doc ${res.created ? "created" : "updated"}: ${res.file}`,
              detail: s.libraryEdit.rationale,
              refId: memo.id,
            });
          } catch (err) {
            pushEvent(state, {
              kind: "error",
              agentId: "sage",
              title: `Library edit rejected: ${s.libraryEdit.file}`,
              detail: String(err),
              refId: run.id,
            });
          }
        }
        if (s.skillEdit && !out.value.usedMock) {
          try {
            const res = await writeSkill({
              name: s.skillEdit.name,
              description: s.skillEdit.description,
              agents: s.skillEdit.agents,
              body: s.skillEdit.body,
            });
            writes.push(`skill ${res.file} ${res.created ? "created" : "updated"}`);
            pushEvent(state, {
              kind: "skill.updated",
              agentId: "sage",
              title: `Skill ${res.created ? "created" : "updated"}: ${s.skillEdit.name}`,
              detail: `${s.skillEdit.rationale} (file ${res.file}; applies to ${s.skillEdit.agents.join(", ")})`,
              refId: memo.id,
            });
          } catch (err) {
            pushEvent(state, {
              kind: "error",
              agentId: "sage",
              title: `Skill edit rejected: ${s.skillEdit.name}`,
              detail: String(err),
              refId: run.id,
            });
          }
        }
        if (!out.value.usedMock) {
          for (const rec of await recordNotes(run.id, s.notebook)) {
            writes.push(`notebook "${rec.entry.topic}"`);
            pushEvent(state, {
              kind: "note.recorded",
              agentId: "sage",
              title: `Notebook ${rec.replaced ? "updated" : "entry"}: ${rec.entry.topic}`,
              detail: rec.entry.text,
              refId: rec.entry.id,
            });
          }
        }
        markRan(sage);
        step({
          agentId: "sage",
          label: "Collective intelligence",
          status: "ok",
          summary: `${pass} pass: ${s.title}${writes.length > 0 ? ` · wrote ${writes.join(", ")}` : ""}${out.value.usedMock ? " (fallback: no writes)" : ""}`,
          durationMs: out.ms,
        });
      } catch (err) {
        sage.status = "error";
        sage.lastError = String(err);
        step({ agentId: "sage", label: "Collective intelligence", status: "error", summary: String(err), durationMs: 0 });
        pushEvent(state, { kind: "error", agentId: "sage", title: "Sage failed", detail: String(err), refId: run.id });
      }
      await saveState(state);
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
