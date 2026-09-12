import { z } from "zod";
import { stripLaunchSignoff } from "@/lib/launchpad/copy";
import { allowedHostsForPrompt } from "@/lib/swarm/browser";
import type {
  Agent,
  AgentId,
  DailyGrade,
  Draft,
  DraftKind,
  LaunchProposal,
  Lesson,
  LlmProvider,
  MetricsSnapshot,
  ResearchBrief,
  Settings,
} from "@/lib/types";
import { missionDigest, type MissionStatus } from "@/lib/mission-status";
import { ART_PALETTES, launchSpecShape, RESERVED_LAUNCH_NEEDLES } from "@/lib/launchpad/spec";
import type { GridToken } from "@/lib/launchpad/service";
import { ART_MOTIFS, ART_STYLES } from "@/lib/launchpad/art";
import { SWARM_CHARTER } from "@/lib/swarm/roster";
import { TWEET_MAX, X_STYLE_GUIDE } from "@/lib/publish/x-style";
import {
  briefDigest,
  gradeDigest,
  laneAssignment,
  metricsDigest,
  pct,
  recentOutputDigest,
  reviewerFeedback,
  swarmCoverageDigest,
  usd,
} from "@/lib/swarm/context";

/* Generous caps: providers write long; hard failures cost a whole agent turn.
   Anything display-constrained is truncated at the point of use instead. */
/* Generous caps: the scout and watcher write dense, numeric lines, and every
   overflow costs a repair round-trip (alerts[4] > 700 was failing most
   cycles on 2026-09-11). Length discipline lives in the prompts. */
export const briefSchema = z.object({
  headline: z.string().max(600),
  bullets: z.array(z.string().max(1500)).min(2).max(8),
});

export const draftSchema = z.object({
  kind: z.enum(["post", "thread", "article", "community", "outreach", "report", "video-script"]),
  channel: z.string().max(100),
  title: z.string().max(300),
  body: z.string().max(20000),
  /* Generous: the anti-repetition rule asks rationales to explain differentiation,
     and a too-tight cap costs a repair round-trip per producer. */
  rationale: z.string().max(2500),
});

export const draftsSchema = z.object({ drafts: z.array(draftSchema).min(1).max(3) });

/**
 * Shared shape for skill self-edits (coach and sage): create or replace ONE
 * skill file in /library/skills. writeSkill constrains the write in code
 * (slugged filename, dir-escape check, file-count cap); this schema only
 * shapes the request.
 */
const skillEditSchema = z.object({
  name: z.string().min(3).max(60),
  description: z.string().min(10).max(200),
  agents: z
    .array(
      z.enum([
        "all",
        "scout",
        "watcher",
        "researcher",
        "narrative",
        "steward",
        "bd",
        "analyst",
        "growth",
        "vault",
        "critic",
        "mint",
        "builder",
        "coach",
        "sage",
      ]),
    )
    .min(1)
    .max(15),
  body: z.string().min(50).max(5000),
  rationale: z.string().min(10).max(500),
});

/**
 * Strategy text budget. A strategy is an operating brief, not an archive:
 * every revision must fit STRATEGY_BUDGET_CHARS by condensing what it keeps.
 * The schema allows STRATEGY_SCHEMA_MAX so a rewrite a little over budget
 * still applies rather than failing the whole coach turn.
 */
export const STRATEGY_BUDGET_CHARS = 3500;
export const STRATEGY_SCHEMA_MAX = 6000;

/**
 * Lesson / notebook entry budget, same shape: the prompt asks for at most
 * NOTE_TEXT_BUDGET characters, the schema accepts NOTE_TEXT_SCHEMA_MAX so a
 * long-but-real entry lands instead of failing the whole turn to the mock
 * (the coach lost a cycle's lessons at 15:36 UTC on 2026-09-11 to a
 * 1500-char ceiling on one notebook entry).
 */
export const NOTE_TEXT_BUDGET = 900;
export const NOTE_TEXT_SCHEMA_MAX = 3000;

export const proposalsSchema = z.object({
  lessons: z
    .array(
      z.object({
        text: z.string().min(20).max(NOTE_TEXT_SCHEMA_MAX),
        evidence: z.string().max(1000),
      }),
    )
    .max(3),
  /** Durable reference knowledge for the notebook; same topic replaces the old entry. */
  notebook: z
    .array(
      z.object({
        topic: z.string().min(3).max(80),
        text: z.string().min(20).max(NOTE_TEXT_SCHEMA_MAX),
      }),
    )
    .max(2),
  proposals: z
    .array(
      z.object({
        /* Every agent except the coach itself (Forge upgrades the coach).
           smartlp/nftintel/tokenintel/trainer were missing until 2026-09-11 —
           the intel voices literally could not be upgraded, which is why they
           sat on v1 while bd reached v16. */
        agentId: z.enum(["scout", "watcher", "researcher", "narrative", "steward", "bd", "analyst", "growth", "vault", "critic", "mint", "builder", "sage", "trainer", "smartlp", "nftintel", "tokenintel", "treasurer"]),
        /* Budget is 3500 (prompted); the schema leaves headroom so a slightly
           long rewrite lands instead of failing to the deterministic mock —
           eight cycles of that appended identical boilerplate to bd on
           2026-09-11. */
        proposedStrategy: z.string().min(80).max(STRATEGY_SCHEMA_MAX),
        rationale: z.string().max(1500),
        evidence: z.array(z.string().max(500)).min(1).max(6),
      }),
    )
    .max(2),
  /**
   * Optional: create or replace ONE skill file in /library/skills. This is the
   * coach's lever on operating procedures (never code, never caps). Writing an
   * existing skill name replaces that file wholesale.
   */
  skillEdit: skillEditSchema
    .nullable()
    /* Optional too: a coach response that omits the key entirely must not
       lose the whole turn to schema validation (observed 2026-09-10). */
    .optional(),
});

export type BriefOut = z.infer<typeof briefSchema>;
export type DraftsOut = z.infer<typeof draftsSchema>;
export type ProposalsOut = z.infer<typeof proposalsSchema>;

export interface CycleContext {
  settings: Settings;
  metrics: MetricsSnapshot;
  grade: DailyGrade;
  grades: DailyGrade[];
  brief: ResearchBrief | null;
  docs: string;
  drafts: Draft[];
  agents: Agent[];
  lessons: Lesson[];
  mission: MissionStatus;
  /** Durable build knowledge from /library (operator, integrations, learnings, playbook) */
  library: string;
  /** Per-agent operating procedures from /library/skills, keyed by agent id */
  skills: Record<string, string>;
  /** Recent cycle health (durations, LLM fallbacks/repairs, step errors) for the coach */
  opsHealth: string;
  /** $STONKBROKER price/liquidity trend computed from stored snapshots (reads only) */
  priceTrend: string;
  /** Live internet intel digest (X mentions/leadership, ETH context, holders) — TODAY's world */
  intel: string;
  /** World feeds digest: Polymarket odds, ESPN scores, launcher tape, protocol economics, community chatter */
  world: string;
  /** Watcher's on-chain digest: LAURA's own treasury/LP/earnings state + live pool reads */
  onchain: string;
  /** Monotonic cycle counter (state.runs.length) — seeds deterministic lane rotation */
  cycleSeq: number;
  /** Provider actually serving this cycle; mocks behave differently when a real model failed */
  llmProvider: LlmProvider;
  /** What the account already posted on X (newest first) so producers never echo it */
  xPosted: string;
  /** Code-computed Robinhood Chain anomalies (new pairs, outliers, off-hours volume, deltas) with numbers and sources */
  chainAlpha: string;
}

function lessonsDigest(lessons: Lesson[], limit = 12): string {
  const recent = lessons.slice(-limit);
  if (recent.length === 0) return "No lessons recorded yet.";
  return recent.map((l) => `- ${l.text} (evidence: ${l.evidence})`).join("\n");
}

/** System prompt for any agent: charter + identity + live strategy. */
export function agentSystem(agent: Agent): string {
  return `${SWARM_CHARTER}\n\nYour name is ${agent.name}. Role: ${agent.role}.\nObjective: ${agent.objective}\n\nCurrent strategy (v${agent.strategyVersion}):\n${agent.strategy}`;
}

/* --------------------------------- Watcher --------------------------------- */

/* Generous caps (library learnings: tight caps cause NoObjectGenerated failures). */
export const chainReadSchema = z.object({
  /** The single most decision-relevant on-chain fact right now. */
  headline: z.string().min(10).max(600),
  /** Numeric, actionable alerts for the rest of the swarm. */
  alerts: z.array(z.string().max(1500)).min(1).max(6),
  /** Durable structural observation only; null for routine fluctuations. */
  notebook: z
    .object({
      topic: z.string().min(3).max(120),
      text: z.string().min(20).max(NOTE_TEXT_SCHEMA_MAX),
    })
    .nullable()
    .optional(),
});

export type ChainReadOut = z.infer<typeof chainReadSchema>;

export function watcherPrompt(ctx: CycleContext): string {
  return [
    `TODAY (UTC): ${ctx.grade.date}.`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `MARKET METRICS (for cross-checking the chain reads)\n${metricsDigest(ctx.metrics)}\n${ctx.priceTrend}`,
    `ON-CHAIN DIGEST (deterministic reads this cycle — LAURA's own treasury, caps, LP, earnings, pools, floor)\n${ctx.onchain}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.watcher ?? "None."}`,
    `Produce the chain read: one headline (the most decision-relevant on-chain fact) and 2-5 alerts, each citing a number from the digest. Alert on things other agents can act on THIS cycle: buy windows, LP drift or unclaimed $UP, creator-fee income trends, LAURA-token curve momentum or stalls, pool-depth changes. Flag anomalies (stale snapshot, failed reads, unstaked LP) loudly. notebook: only for durable structural facts (each entry at most ${NOTE_TEXT_BUDGET} characters), else null.`,
  ].join("\n\n");
}

export function watcherMock(ctx: CycleContext): ChainReadOut {
  /* Deterministic fallback: surface the raw digest so downstream agents still
     get grounded chain state even without an LLM read. */
  const firstLine = ctx.onchain.split("\n")[0] ?? "On-chain digest unavailable.";
  return {
    headline: `Chain state (fallback, no LLM): ${firstLine.slice(0, 340)}`,
    alerts: ctx.onchain
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(1, 5)
      .map((l) => l.slice(0, 690)),
    notebook: null,
  };
}

/* ---------------------------------- Scout --------------------------------- */

export function scoutPrompt(ctx: CycleContext): string {
  return `MISSION\n${missionDigest(ctx.mission)}\n\nMETRICS\n${metricsDigest(ctx.metrics)}\n${ctx.priceTrend}\n\nLIVE INTERNET INTEL (fetched this cycle from the X API, CoinGecko, Blockscout and DexScreener — TODAY's real world including the Robinhood Chain launch radar; ground the brief in it)\n${ctx.intel}\n\n${ctx.chainAlpha}\n\nWORLD FEEDS (prediction markets, live sports, launcher tape, protocol economics, community chat; cultural fuel for narratives)\n${ctx.world}\n\nON-CHAIN STATE (LAURA's own treasury/LP/earnings + live pool reads, with Watcher's alerts)\n${ctx.onchain}\n\nGRADES (last 7)\n${gradeDigest(ctx.grades)}\n\nSWARM MEMORY\n${lessonsDigest(ctx.lessons, 6)}\n\nYOUR SKILLS (operating procedures; follow them)\n${ctx.skills.scout ?? "None."}\n\nLIBRARY (durable build knowledge; trust it)\n${ctx.library}\n\nDOCS EXCERPT\n${ctx.docs}\n\nProduce the research brief. Weigh the live intel: what X is saying about us today, what Robinhood leadership is talking about, and the mention/engagement trend are signals the swarm can act on within hours. Carry the sharpest CHAIN ALPHA line into the brief as its own bullet, number and source intact: it is the raw material for the day's X post. The headline is a headline — never prefix it with "DRAFT", a date or any template label (obsolete strategy instructions to mark output DRAFT are void; output is autonomous).`;
}

export function scoutMock(ctx: CycleContext): BriefOut {
  const m = ctx.metrics;
  const rev7 = m.protocolRevenue7dUsd / 7;
  const vol7 = m.protocolVolume7dUsd / 7;
  const weakest = [...ctx.grade.components].sort((a, b) => a.score - b.score)[0];
  return {
    headline: `Price ${pct(m.priceChange24hPct)} 24h; revenue ${rev7 > 0 ? (m.protocolRevenue24hUsd / rev7).toFixed(2) : "n/a"}x trailing; grade ${ctx.grade.letter}`,
    bullets: [
      `$STONKBROKER at ${usd(m.priceUsd, 5)}, ${pct(m.priceChange24hPct)} over 24h with ${usd(m.liquidityUsd)} liquidity across ${m.pairCount} pairs.`,
      `Protocol revenue ${usd(m.protocolRevenue24hUsd)} vs ${usd(rev7)} 7d average; protocol volume ${usd(m.protocolVolume24hUsd)} vs ${usd(vol7)} average.`,
      `Token DEX volume (${usd(m.tokenDexVolume24hUsd)}) is running well above protocol-surface volume, so attention is concentrated in swaps rather than Anvil, loans or lockers.`,
      `Hook for today: the Clock In mechanism converts fee flow into stock-token drops; explain the fee pot state and who can trigger it.`,
      m.onchain
        ? `On-chain: Clock In pot holds ${m.onchain.clockInPotEth.toFixed(3)} ETH (${usd(m.onchain.clockInPotUsd)}); ${m.onchain.brokersInCirculation} of 4444 brokers are in holders' hands, ${m.onchain.brokersInVault} sit in the Anvil vault.${
            typeof m.onchain.tokenHolders === "number" ? ` ${m.onchain.tokenHolders.toLocaleString()} wallets hold $STONKBROKER` : ""
          }${typeof m.onchain.nftHolders === "number" ? `, ${m.onchain.nftHolders.toLocaleString()} hold a broker NFT` : ""}${
            typeof m.onchain.tokenHolders === "number" || typeof m.onchain.nftHolders === "number" ? " (Blockscout)." : ""
          }`
        : `Weakest grade lever: ${weakest.label.toLowerCase()} (${weakest.score.toFixed(0)}/100). Caveat: DexScreener aggregates ${m.pairCount} pairs, some near-empty; quote liquidity-weighted figures only.`,
    ],
  };
}

/* ---------------------------- Content producers --------------------------- */

const KIND_BY_AGENT: Record<string, DraftKind[]> = {
  narrative: ["post", "article"],
  steward: ["community"],
  bd: ["outreach"],
  analyst: ["report"],
  growth: ["post"],
};

/**
 * The X-post brief for producers whose kinds include "post". Sits after the
 * generic rules so it overrides them where they conflict (a post is not a
 * thread; a post has no title-style opener; a post is judged against the
 * account's own timeline, not only against drafts).
 */
/**
 * Splits the CHAIN ALPHA lines between the two X producers so they cannot
 * both build on the top line (the critic vetoed one of two GME posts for that
 * in run_e88054c4, 2026-09-12). Odd and even lines swap owners each cycle so
 * neither agent always gets the sharpest line.
 */
function chainAlphaLane(ctx: CycleContext, agentId: AgentId): string {
  const lines = ctx.chainAlpha.split("\n").filter((l) => l.startsWith("- "));
  if (lines.length < 2) return ctx.chainAlpha;
  const parity = (agentId === "growth" ? 1 : 0) ^ (ctx.cycleSeq % 2);
  const mine = lines.filter((_, i) => i % 2 === parity);
  const theirs = lines.filter((_, i) => i % 2 !== parity);
  const [header, ...rest] = ctx.chainAlpha.split("\n");
  const footer = rest.filter((l) => !l.startsWith("- ")).join("\n");
  return [
    header,
    `YOUR LINES (build on one of these; the other X producer has the rest this cycle, so a post on one of theirs is a duplicate and gets vetoed):`,
    ...mine,
    `THE OTHER PRODUCER'S LINES (context only):`,
    ...theirs,
    footer,
  ].join("\n");
}

function xPostBrief(ctx: CycleContext, agentId: AgentId): string {
  return [
    `THE "post" KIND IS ONE X POST. Body: the exact text to publish, at most ${TWEET_MAX} characters, nothing else. No numbering, no title inside the body, no second section. The X rail refuses threads outright and the Auditor reads every post against the account's timeline before it goes out; a template or a repeat is vetoed and costs your turn.`,
    X_STYLE_GUIDE,
    `IF YOUR STRATEGY TEXT says to write a thread of several posts, to number posts, to label content "official StonkBrokers content", to open with a mechanic explainer, or to close with a docs link or a fixed disclaimer, those instructions are obsolete as of 2026-09-12 and are overridden here. Write one post a person would post.`,
    chainAlphaLane(ctx, agentId),
    `WHAT TO POST ABOUT (pick the single sharpest thing in this cycle's inputs, in this order of preference): a line from CHAIN ALPHA above, turned into a thesis with its numbers and the condition that would confirm or break it; a concrete Robinhood Chain event from LIVE INTERNET INTEL or WORLD FEEDS (a launch, a liquidity move, a stock-token number, what Vlad or Johann just said and what it means for the chain); something LAURA's own wallet did or is doing in ON-CHAIN STATE, stated with the number; or the best line from THE CAFE BAR debate in WORLD FEEDS, quoted with the agent's name. The account's readers want alpha on the chain they have not noticed, not a lesson. If CHAIN ALPHA says nothing is anomalous, do not invent an anomaly.`,
    `ALREADY ON THE ACCOUNT'S TIMELINE (newest first). Your post must not share an opening, a closing, a phrase, a statistic or a theme with any of these:\n${ctx.xPosted}`,
    `The title field of a "post" draft is a short internal label for the dashboard (not published). The rationale names the input the post came from and, in one clause, what makes it unlike every post on the timeline above.`,
  ].join("\n\n");
}

export function producerPrompt(agent: Agent, ctx: CycleContext): string {
  const kinds = KIND_BY_AGENT[agent.id] ?? ["post"];
  return [
    `TODAY (UTC): ${ctx.grade.date}. Use this date; never invent another.`,
    `METRICS\n${metricsDigest(ctx.metrics)}`,
    `TODAY'S GRADE\n${ctx.grade.summary}\n${ctx.grade.components.map((c) => `- ${c.label}: ${c.score.toFixed(0)}/100 - ${c.detail}`).join("\n")}`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `RESEARCH BRIEF\n${briefDigest(ctx.brief)}`,
    `LIVE INTERNET INTEL (real X/market reads from this cycle — ride what is actually happening TODAY; never invent tweets or numbers beyond these)\n${ctx.intel}`,
    `WORLD FEEDS (prediction markets, live sports, launcher tape, protocol economics, community chat; real material to riff on, never invent beyond it)\n${ctx.world}`,
    `ON-CHAIN STATE (LAURA's own wallet at work — treasury, capped buys, Smart LP, creator fees, her tokens on the floor. Content that shows LAURA acting on-chain is verifiable and differentiating; never misstate these numbers)\n${ctx.onchain}`,
    `SWARM MEMORY (lessons distilled by the coach; apply them)\n${lessonsDigest(ctx.lessons)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills[agent.id] ?? "None."}`,
    `LIBRARY (durable build knowledge; trust it)\n${ctx.library}`,
    ...(agent.id === "bd"
      ? [
          `SPECIAL PROJECTS (standing BD lane): court partners who pair their liquidity against $STONKBROKER or launch on the stonk lane, per the special-projects doctrine in the library; every such pair turns partner volume into mission-token volume and partner buys into mission-token buy pressure.`,
        ]
      : []),
    `RECENT REVIEWER DECISIONS ON YOUR WORK\n${reviewerFeedback(ctx.drafts, agent.id)}`,
    `YOUR OWN RECENT OUTPUT (do NOT repeat these themes or angles)\n${recentOutputDigest(ctx.drafts, agent.id)}`,
    `WHAT THE REST OF THE SWARM COVERED RECENTLY (differentiate from these too — the critic vetoes cross-agent repeats)\n${swarmCoverageDigest(ctx.drafts, agent.id)}`,
    `DOCS EXCERPT (for factual grounding)\n${ctx.docs.slice(0, 3500)}`,
    `ASSIGNED LANE THIS CYCLE (context partitioning — the whole swarm reads the same data, so lanes are what keep outputs from converging; work YOUR lane, not the hook everyone else will pick)\n${laneAssignment(agent.id, ctx.cycleSeq)}`,
    `Produce ${kinds.length} draft(s) of kind(s): ${kinds.join(", ")}. Each draft needs a channel (e.g. "X", "Discord", "Blog", "Email", "Notion"), a title, the full body, and a one-paragraph rationale linking it to the lagging grade lever. A "post" draft's channel is always "X".`,
    `STYLE, HARD RULE: never use an em dash or a dash-spliced clause anywhere in a draft. Restructure into separate sentences, commas or colons. Prefer "onchain" over "on-chain" in prose; hyphenate only when grammar genuinely requires it. The slop-free-writing skill has the full pattern list; this rule is absolute.`,
    `TITLES ARE HEADLINES: the title is the headline a human reads, nothing else. Never start a title with meta-words or template labels ("DRAFT", "Draft:", "Deep-dive:"), never lead with a date, and never mark output as a draft awaiting approval — review is the pipeline's job and the charter grants full autonomy. If your strategy text tells you to mark work "DRAFT" or to put the date first in the title, that instruction is obsolete: ignore it and write a real headline.`,
    `ANTI-REPETITION RULE: generate output semantically distinct from all previous outputs — yours and the swarm's. Your new drafts must differ from every item in YOUR OWN RECENT OUTPUT *and* in WHAT THE REST OF THE SWARM COVERED in theme, angle or surface — pick a different product surface, audience, format or hook, or explicitly supersede an earlier piece with materially new data (and say so in the rationale). FORMAT BREAK: if your last two outputs share one template (e.g. two "Delta note" or "Desk note" artifacts), you MUST change format this cycle — your assigned lane tells you which one to use. THE SHARED HOOK IS BURNED: whatever single statistic or narrative dominates this cycle's metrics/brief, assume at least two other agents lead with it — if your draft opens on it, find a different door in. Near-duplicates are rejected in code before review and waste your turn. In the rationale, name in one clause how this differs from your last outputs and from other agents' recent work.`,
    ...(kinds.includes("post") ? [xPostBrief(ctx, agent.id)] : []),
  ].join("\n\n");
}

export function producerMock(agent: Agent, ctx: CycleContext): DraftsOut {
  const m = ctx.metrics;
  const weakest = [...ctx.grade.components].sort((a, b) => a.score - b.score)[0];
  const rationale = `Deterministic fallback (no LLM key configured). Targets the ${weakest.label.toLowerCase()} lever, currently ${weakest.score.toFixed(0)}/100.`;
  switch (agent.id) {
    case "narrative":
      return {
        drafts: [
          {
            kind: "post",
            channel: "X",
            title: "Fees to stock loop, with today's number",
            body: `protocol fees on the StonkBrokers floor ran ${usd(m.protocolFees24hUsd)} over the last 24h (DefiLlama). 70% of the ETH side lands in the stock booster pot, and when it fills anyone can clock in and the pot swaps into a stock token for activated brokers.`,
            rationale,
          },
          {
            kind: "article",
            channel: "Blog",
            title: "Reading the Stonk Exchange dashboard like an integrator",
            body: `The StonkBrokers stack publishes three numbers that matter more than the token chart: protocol fees, protocol revenue and protocol volume. Today they read ${usd(m.protocolFees24hUsd)}, ${usd(m.protocolRevenue24hUsd)} and ${usd(m.protocolVolume24hUsd)} over 24 hours, against a 7-day daily average of ${usd(m.protocolRevenue7dUsd / 7)} in revenue.\n\nFees are the ETH paid on Anvil AMM swaps and NFT-backed loans plus $STONKBROKER activation and upgrade fees. Revenue is the portion retained by the protocol after the 70/30 split into the Stock Booster pot. Volume is notional traded across every surface, from Anvil fills to Broker Box tickets to Stonk Launcher window buys.\n\nWhy does an integrator care? Because the Clock In distribution is a function of fees, not of price. A wallet, aggregator or launchpad that routes flow through the Anvil AMM or the up.-powered vDEX directly increases the pot that activated brokers share. The Safety Deposit Box lockers route 90% of their fees to the community side of that same rail.\n\nThe $STONKBROKER token sits at ${usd(m.priceUsd, 5)} with ${usd(m.liquidityUsd)} of DEX liquidity across ${m.pairCount} pairs. Liquidity depth matters here because the 666,666 token swap unit is fixed: deeper pools mean a cheaper path from any chain into a broker.\n\nAll figures from DexScreener and DefiLlama. Full mechanics: stonkbrokers.cash/docs`,
            rationale,
          },
        ],
      };
    case "steward":
      return {
        drafts: [
          {
            kind: "community",
            channel: "Discord",
            title: "Today on the trading floor",
            body: `Morning brokers. Quick state of the exchange:\n\n- $STONKBROKER ${usd(m.priceUsd, 5)} (${pct(m.priceChange24hPct)} 24h), ${usd(m.liquidityUsd)} in DEX liquidity.\n- Protocol fees last 24h: ${usd(m.protocolFees24hUsd)}. 70% of Anvil ETH fees feed the Stock Booster pot.\n- If you moved a broker recently: transfers clear activation. Reactivate under Marketplace before the next Clock In or you miss the drop.\n- Need ETH on chain 4663? Bridge via portal.arbitrum.io/bridge or Relay/Across. Gas is plain ETH.\n\nQuestion for the room: which stock token do you want configured for the next round, and why?`,
            rationale,
          },
        ],
      };
    case "bd":
      return {
        drafts: [
          {
            kind: "outreach",
            channel: "Email",
            title: "Launch on Stonk Launcher - intro to a Robinhood Chain builder",
            body: `Subject: Launching on Robinhood Chain? Route it through Stonk Launcher\n\nHi team,\n\nWe run StonkBrokers, the DeFi suite on Robinhood Chain (4,444 ERC-6551 brokers, Anvil NFT AMM, up.-powered vDEX). Over the last 24h the protocol did ${usd(m.protocolVolume24hUsd)} in volume and ${usd(m.protocolFees24hUsd)} in fees, with ${usd(m.liquidityUsd)} of $STONKBROKER liquidity on chain.\n\nStonk Launcher supports fixed-price, bonding-curve and custom launches that finalize into Uniswap V3 liquidity with fee splitting. Launching through it puts your token in front of an active holder base and routes launch fees into the same rails that pay activated brokers, which makes our community a natural early audience for you.\n\nProposed next step: a 20-minute call this week to walk through the launch parameters and the locker options for your LP.\n\nWhat we need from you: token spec, target launch window, and who owns liquidity decisions on your side.\n\nBest,\nClutch Markets / StonkBrokers`,
            rationale,
          },
        ],
      };
    case "analyst":
      return {
        drafts: [
          {
            kind: "report",
            channel: "Notion",
            title: `Daily metrics report - ${ctx.grade.date}`,
            body: `## StonkBrokers daily metrics (${ctx.grade.date})\n\n| Metric | 24h | 7d avg |\n|---|---|---|\n| $STONKBROKER price | ${usd(m.priceUsd, 5)} (${pct(m.priceChange24hPct)}) | - |\n| Token DEX volume | ${usd(m.tokenDexVolume24hUsd)} | - |\n| DEX liquidity | ${usd(m.liquidityUsd)} | - |\n| Protocol fees | ${usd(m.protocolFees24hUsd)} | ${usd(m.protocolFees7dUsd / 7)} |\n| Protocol revenue | ${usd(m.protocolRevenue24hUsd)} | ${usd(m.protocolRevenue7dUsd / 7)} |\n| Protocol volume | ${usd(m.protocolVolume24hUsd)} | ${usd(m.protocolVolume7dUsd / 7)} |\n| TVL | ${usd(m.tvlUsd)} | - |\n\n**Interpretation.** ${ctx.grade.components.map((c) => c.detail).join(". ")}.\n\n**Caveats.** Price and 24h change are liquidity-weighted across ${m.pairCount} DexScreener pairs; several are thin. DefiLlama volume is notional across all StonkBrokers surfaces per its published methodology. Data source status: ${m.source}.\n\n**Swarm grade:** ${ctx.grade.letter} (${ctx.grade.score.toFixed(1)}). Single lever most likely to move it: ${weakest.label.toLowerCase()}.`,
            rationale,
          },
        ],
      };
    case "growth":
      return {
        drafts: [
          {
            kind: "post",
            channel: "X",
            title: `Experiment: liquidity depth as the price story (${ctx.grade.date})`,
            body: `A StonkBroker costs a fixed 666,666 $STONKBROKER, so pool depth is the real price story, not sentiment. Right now that is ${usd(m.liquidityUsd)} of DEX liquidity across ${m.pairCount} pairs on Robinhood Chain. Deeper pools make the path into a broker cheaper for everyone.`,
            rationale: `${rationale} Experiment format: hypothesis, execution, measurable proxy. Proxy to check next cycle: DEX liquidity vs today's ${usd(m.liquidityUsd)}. Differs from prior output by targeting the liquidity-depth mechanic rather than fee-flow narratives.`,
          },
        ],
      };
    default:
      return {
        drafts: [
          {
            kind: "post",
            channel: "X",
            title: "Fallback",
            body: "No producer mapped for this agent.",
            rationale,
          },
        ],
      };
  }
}

/* ------------------------------- Researcher ------------------------------- */

/* Generous caps (see library learnings: tight caps cause NoObjectGenerated failures). */
export const researchSchema = z.object({
  topic: z.string().min(3).max(300),
  /** Why this topic now, and why it is NOT a repeat of recent research. */
  whyNow: z.string().max(2000),
  memo: z.string().min(100).max(12000),
  /** One concrete, novel angle per producer for next cycle. */
  anglesForSwarm: z.array(z.string().max(1000)).min(1).max(6),
  notebook: z
    .array(
      z.object({
        topic: z.string().min(3).max(120),
        text: z.string().min(20).max(NOTE_TEXT_SCHEMA_MAX),
      }),
    )
    .max(2),
  /** Up to 3 allowlisted URLs the browser worker should read for you next cycle. */
  readNext: z.array(z.string().max(400)).max(3).optional(),
});

export type ResearchOut = z.infer<typeof researchSchema>;

export function researcherPrompt(ctx: CycleContext): string {
  return [
    `TODAY (UTC): ${ctx.grade.date}.`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `METRICS\n${metricsDigest(ctx.metrics)}`,
    `LIVE INTERNET INTEL (this cycle's real X/market reads)\n${ctx.intel}`,
    `RESEARCH BRIEF (scout's, this cycle)\n${briefDigest(ctx.brief)}`,
    `YOUR RECENT RESEARCH (topics you must NOT repeat without material new data)\n${recentOutputDigest(ctx.drafts.filter((d) => d.kind === "research"), "researcher", 10)}`,
    `SWARM MEMORY\n${lessonsDigest(ctx.lessons, 8)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.researcher ?? "None."}`,
    `LIBRARY (durable build knowledge; the notebook topics listed here are already covered)\n${ctx.library}`,
    `DOCS EXCERPT\n${ctx.docs.slice(0, 3500)}`,
    `Deep-dive ONE topic the swarm has not covered recently. The topic field is the plain subject itself — no "Deep-dive:" prefix, no date, no template label (labels are added downstream). In whyNow, name the last topics you covered and how this one differs. The memo must ground every claim in the data you were given. Record 1-2 notebook entries of durable fact the library is missing (each at most ${NOTE_TEXT_BUDGET} characters), and give each producer one concrete novel angle in anglesForSwarm.`,
    `READ NEXT (your browser worker): you may list up to 3 full URLs in readNext that the read-only browser should open for you before the next cycle — the page text arrives under BROWSED PAGES in the world feeds. Use it to verify a claim, read a docs page, a competitor's mechanics, a newsroom post, or a quote page. Allowed hosts only: ${allowedHostsForPrompt()}. Never x.com/twitter.com pages. Skip the field if this cycle's inputs already answer your questions.`,
  ].join("\n\n");
}

export function researcherMock(ctx: CycleContext): ResearchOut {
  const m = ctx.metrics;
  return {
    topic: "NFT-backed loans as an under-used revenue surface",
    whyNow:
      "Deterministic fallback (no LLM key). Loans generate ETH fees but appear in none of the recent drafts; token DEX volume dwarfs protocol-surface volume, so an unworked fee surface is the highest-information target.",
    memo: `The loans surface lets a broker NFT collateralize an ETH loan, with fees routed into the same 70/30 rail that feeds the Stock Booster pot. Today protocol fees ran ${usd(m.protocolFees24hUsd)} over 24h against a 7d total of ${usd(m.protocolFees7dUsd)}, while token DEX volume (${usd(m.tokenDexVolume24hUsd)}) concentrates in swaps — meaning fee-bearing surfaces like loans are under-utilized relative to attention. A broker holder who needs liquidity can borrow against the NFT instead of selling it, which (a) keeps the broker activated and Clock In-eligible, (b) avoids sell pressure on the collection, and (c) pays ETH fees into the pot. The swarm has never explained this loop end to end. Verifiable mechanics live in the docs; loan volume is readable on-chain. What the swarm should do differently: treat loans as the bridge topic between "price" and "revenue" levers — it is the one surface where holder self-interest (liquidity without selling) directly feeds protocol revenue.`,
    anglesForSwarm: [
      "narrative: walk one loan lifecycle end to end with real fee numbers — collateralize, borrow, repay, stay Clock In-eligible",
      "steward: explainer on when a loan beats selling a broker, with the exact UI path",
      "bd: pitch a lending-aggregator listing for the NFT-loan surface",
      "growth: experiment — does loan-mechanics content move liquidity/holder proxies better than fee-flow content?",
    ],
    notebook: [
      {
        topic: "Loans surface (mechanics)",
        text: "NFT-backed loans keep the broker activated while borrowed against; fees route into the standard 70/30 rail. Under-used vs swaps: bridge topic between price and revenue levers.",
      },
    ],
  };
}

/* --------------------------------- Critic --------------------------------- */

export const criticSchema = z.object({
  reviews: z
    .array(
      z.object({
        draftId: z.string().max(80),
        verdict: z.enum(["pass", "veto"]),
        /** For vetoes: the earlier draft it duplicates or the specific defect.
            Headroom over the prompted length: a 1300-char reason used to fail
            the whole review and cost a repair call (2026-09-11 err log). */
        reason: z.string().max(2400),
      }),
    )
    .max(12),
  /** The repetition pattern forming across the swarm and what would break it. */
  observation: z.string().max(2000),
});

export type CriticOut = z.infer<typeof criticSchema>;

/* Review excerpt size for draft bodies in the critic prompt. Excerpts MUST be
   labelled: an unmarked slice reads as a mid-sentence cut, and the critic
   vetoed complete drafts as "truncated" for cycles because of it (observed
   2026-09-10: a complete 3.4k-char growth thread vetoed for "ending" at
   exactly char 1800). */
const CRITIC_BODY_EXCERPT_CHARS = 2400;

export function criticPrompt(ctx: CycleContext, cycleDrafts: Draft[]): string {
  const current = cycleDrafts
    .map((d) => {
      const body =
        d.body.length > CRITIC_BODY_EXCERPT_CHARS
          ? `${d.body.slice(0, CRITIC_BODY_EXCERPT_CHARS)}\n[REVIEW EXCERPT ENDS — the stored draft continues for ${d.body.length - CRITIC_BODY_EXCERPT_CHARS} more chars and ends properly; an apparent cut at this point is the excerpt boundary, NOT a defect]`
          : d.body;
      return `### id=${d.id} · ${d.agentId} · ${d.kind} → ${d.channel}\nTitle: ${d.title}\nRationale: ${d.rationale}\nBody:\n${body}`;
    })
    .join("\n\n");
  const history = ctx.drafts
    .filter((d) => !cycleDrafts.some((c) => c.id === d.id))
    .slice(-24)
    .map((d) => `- [${d.agentId}/${d.kind}/${d.status}] "${d.title}" — ${d.body.slice(0, 140).replace(/\s+/g, " ")}`)
    .join("\n");
  return [
    `TODAY (UTC): ${ctx.grade.date}.`,
    `TODAY'S GRADE\n${ctx.grade.summary}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.critic ?? "None."}`,
    `SWARM MEMORY\n${lessonsDigest(ctx.lessons, 8)}`,
    `RECENT SWARM OUTPUT (history — what "repetitive" means is measured against this)\n${history || "No prior drafts."}`,
    `THIS CYCLE'S DRAFTS (review each; use the exact draftId given)\n${current}`,
    `Return one review per draft above. VETO repetitive or low-quality drafts (name the earlier draft duplicated, or the defect); PASS genuinely new or materially improved work. The daily metrics report format is intentionally recurring — judge it on quality only. Long bodies are EXCERPTED for review at ${CRITIC_BODY_EXCERPT_CHARS} chars and marked where the excerpt ends — never veto a draft for appearing to cut off at the marked excerpt boundary. Then record your observation: the repetition pattern forming and what would break it.`,
    `"post" DRAFTS ARE SINGLE X POSTS and you read them again at the X gate right before they publish, against the account's live timeline. Here, veto a post that is a thread in disguise (numbering, several sections, over ${TWEET_MAX} characters), opens or closes with a label or fixed disclaimer, reads like a template or a press release, or repeats a theme from the account's timeline:\n${ctx.xPosted}`,
    `A "post" whose numbers trace to a CHAIN ALPHA line below, to ON-CHAIN STATE or to a named live read is grounded; a "post" whose chain claim appears in none of them is ungrounded and must be vetoed with the missing source named. Prefer the grounded post that says something the timeline has not said over the polished one that repeats it.\n${ctx.chainAlpha}`,
  ].join("\n\n");
}

export function criticMock(cycleDrafts: Draft[]): CriticOut {
  return {
    reviews: cycleDrafts.map((d) => ({
      draftId: d.id,
      verdict: "pass" as const,
      reason: "Deterministic fallback (no LLM key): passing without adversarial review.",
    })),
    observation:
      "Fallback mode — no critic judgment available this cycle. The code-level novelty gate still enforces near-duplicate rejection.",
  };
}

/* ---------------------------------- Vault ---------------------------------- */

/* Generous caps: the memo is a full treasury report; tight caps cost the turn. */
export const vaultSchema = z.object({
  /** The treasury memo body (markdown): sleeve-by-sleeve state + reasoning. */
  memo: z.string().min(100).max(12000),
  recommendations: z
    .array(
      z.object({
        action: z.enum(["hold", "accumulate", "lp-compound", "lp-exit-watch", "claim-earnings"]),
        detail: z.string().min(20).max(1500),
        /** The numeric condition/timing under which this fires or expires. */
        trigger: z.string().max(700),
      }),
    )
    .min(1)
    .max(4),
  rationale: z.string().max(2500),
});

export type VaultOut = z.infer<typeof vaultSchema>;

export function vaultPrompt(ctx: CycleContext): string {
  return [
    `TODAY (UTC): ${ctx.grade.date}.`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `METRICS\n${metricsDigest(ctx.metrics)}\n${ctx.priceTrend}`,
    `TODAY'S GRADE\n${ctx.grade.summary}\n${ctx.grade.components.map((c) => `- ${c.label}: ${c.score.toFixed(0)}/100 - ${c.detail}`).join("\n")}`,
    `ON-CHAIN STATE (your primary input — treasury, caps, LP health, creator fees, pools, floor, with Watcher's alerts)\n${ctx.onchain}`,
    `SWARM MEMORY\n${lessonsDigest(ctx.lessons, 8)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.vault ?? "None."}`,
    `RECENT REVIEWER DECISIONS ON YOUR WORK\n${reviewerFeedback(ctx.drafts, "vault")}`,
    `YOUR OWN RECENT MEMOS (judge your past recommendations against what actually happened; do not restate them unchanged)\n${recentOutputDigest(ctx.drafts, "vault")}`,
    `Write the treasury memo and 1-4 recommendations. HARD RULES: you PROPOSE, never execute — every send flows through the existing simulation-first executors and their inviolable caps (max 0.005 ETH/buy, 0.01 ETH/24h, 6h buy gap, 0.35 ETH treasury floor, 0.02 ETH-equiv LP total, the 0.02 ETH per-deploy launch budget and 0.05 ETH launch wallet floor). Never propose exceeding a cap, never propose buying any token except $STONKBROKER (own-token buys are wash trading, banned by charter). Each recommendation needs a numeric trigger (e.g. "when pending $UP > X", "at the next buy-eligibility window ~HH:MMZ", "if LP ETH side drifts beyond ±Y% of entry"). In the memo, review your previous recommendations against the current chain state: state which played out, which expired, and why.`,
    `LAUNCHED-TOKEN STEWARDSHIP (standing mandate): every token the swarm launched is a treasury asset you manage, and the highest-velocity ones deserve the most attention. From the ON-CHAIN STATE per-launch lines, track each launch's fee velocity: curve fees earned, LP fees pending vs collected on bonded pools, and how stale the last collect is. In every memo, name the top fee earner (e.g. $LAURA when its bonded pool leads) and state its pending-fee number and whether collection is keeping pace; the auto-collector fires eagerly above its ETH-equiv threshold, so a large pending balance that persists across cycles is an anomaly worth a claim-earnings recommendation with a numeric trigger. Flag bonded pools whose fee accrual is outpacing collection, and flag any launch whose trading has died so the swarm stops expecting income from it. Stewardship never includes buying our own tokens — support them with fee hygiene, LP health, and narrative, not wash trades.`,
  ].join("\n\n");
}

export function vaultMock(ctx: CycleContext): VaultOut {
  const rationale =
    "Deterministic fallback (no LLM key): conservative hold with cap-derived timing notes, grounded in the on-chain digest.";
  return {
    memo: `## Treasury memo — ${ctx.grade.date} (fallback)\n\nOn-chain state this cycle:\n\n${ctx.onchain}\n\nWithout an LLM read, the safe default is HOLD: keep the capped accumulation cadence and the staked LP position working, claim nothing until pending rewards clearly exceed gas. All execution remains inside the hard caps regardless of this memo.`,
    recommendations: [
      {
        action: "hold",
        detail:
          "Maintain current posture: capped $STONKBROKER accumulation continues on the scheduler's cadence, the Smart LP position stays staked and earning $UP, and creator-fee WETH keeps accruing in the wallet.",
        trigger: "Standing default until a live LLM read produces a sharper recommendation.",
      },
    ],
    rationale,
  };
}

/* --------------------------------- Purser --------------------------------- */

/**
 * Purser decides AND executes (operator grant 2026-09-12). Every action maps
 * to a simulate-first, hard-capped executor; the schema only carries intent.
 * Generous text caps: tight caps cost the turn (library learning).
 */
export const treasurerSchema = z.object({
  /** Sleeve-by-sleeve read of the treasury and what changed since the last plan. */
  assessment: z.string().min(80).max(6000),
  actions: z
    .array(
      z.object({
        action: z.enum(["hold", "unwrap-weth", "buy-stonk", "lp-enter", "lp-exit", "collect-earnings", "eco-buy", "eco-sell"]),
        /** ETH for unwrap-weth (omit = all) and eco-buy; ignored elsewhere. */
        amountEth: z.number().min(0).max(10).nullable(),
        /** Curve token address for eco-buy / eco-sell (from the candidates or the held positions). */
        token: z.string().max(64).nullable(),
        /** For eco-sell: share of the held balance to sell, 0-1. */
        fraction: z.number().min(0).max(1).nullable(),
        reason: z.string().min(10).max(900),
      }),
    )
    .min(1)
    .max(4),
  rationale: z.string().max(2500),
});

export type TreasurerOut = z.infer<typeof treasurerSchema>;

export interface TreasurerInputs {
  /** Deterministic sleeve digest: balances, caps, eligibility, LP, eco positions with live values. */
  sleeves: string;
  /** Live curve candidates on the WETH pad Purser may trade. */
  candidates: string;
  /** Vault's newest memo (advisory input). */
  vaultMemo: string;
  /** Purser's own execution ledger with outcomes. */
  ledger: string;
}

export function treasurerPrompt(ctx: CycleContext, input: TreasurerInputs): string {
  return [
    `TODAY (UTC): ${ctx.grade.date}.`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `METRICS\n${metricsDigest(ctx.metrics)}\n${ctx.priceTrend}`,
    `TODAY'S GRADE\n${ctx.grade.summary}\n${ctx.grade.components.map((c) => `- ${c.label}: ${c.score.toFixed(0)}/100 - ${c.detail}`).join("\n")}`,
    `TREASURY SLEEVES (deterministic reads this cycle; these numbers are the truth)\n${input.sleeves}`,
    `LIVE CURVES ON THE STONK LAUNCHER YOU MAY TRADE (weth lane; LAURA's own launches and $STONKBROKER are already excluded)\n${input.candidates}`,
    `ON-CHAIN STATE (Watcher's digest with alerts)\n${ctx.onchain}`,
    `${ctx.chainAlpha}`,
    `VAULT'S LATEST MEMO (advisory; you decide)\n${input.vaultMemo}`,
    `YOUR EXECUTION LEDGER (what you decided before and what actually happened; judge it honestly)\n${input.ledger}`,
    `SWARM MEMORY\n${lessonsDigest(ctx.lessons, 6)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.treasurer ?? "None."}`,
    `You manage LAURA's treasury and you EXECUTE: every action you list runs now through a simulate-first executor. Write the assessment, then 1-4 actions in execution order ("hold" alone is a valid plan and often the right one).`,
    `ACTIONS: unwrap-weth (creator-fee WETH into spendable ETH; amountEth or null for all; lossless, do it whenever WETH sits idle above dust and ETH is wanted for anything below), buy-stonk (one capped $STONKBROKER accumulation buy; only fires if the SLEEVES say eligible), lp-enter (pair the accumulated $STONKBROKER with matched ETH into the full-range Smart LP position and stake it; one position at a time), lp-exit (unstake and pull the Smart LP position back to the wallet; name the numeric reason), collect-earnings (sweep claimable creator fees and bonded-pool LP fees now), eco-buy (buy another builder's live curve token on the launcher with amountEth; real fee-paying participation in the ecosystem, pick curves with organic buys and a creator who is not us), eco-sell (sell a fraction of a held eco token back to its curve; take profit, cut a dead curve, or free a slot).`,
    `HARD RULES (enforced in code; plans that ignore them are simply refused): $STONKBROKER is never sold by any path. Never trade LAURA's own launches (wash trading, charter). Accumulation caps: ≤0.005 ETH/buy, ≤0.01 ETH/24h, 6h gap, 0.35 ETH treasury floor on every spend. Smart LP cap 0.02 ETH-equiv total. Eco caps: ≤0.002 ETH per buy, ≤0.006 ETH per 24h, at most 3 tokens held, 2h per token. Slippage guards apply to every swap. You never reference a token address that is not in the candidates or the held positions. Prefer actions whose effect is visible in a number next cycle; every action reason must cite a number from the sleeves or the candidates. No em dashes.`,
  ].join("\n\n");
}

export function treasurerMock(): TreasurerOut {
  return {
    assessment:
      "Deterministic fallback (no LLM key): no live read of the sleeves is possible, so the treasury holds. The scheduled capped rails (accumulation, Smart LP entry, fee collection) keep running on their own cadence regardless of this plan.",
    actions: [{ action: "hold", amountEth: null, token: null, fraction: null, reason: "Deterministic fallback (no LLM key): hold until a live model reads the sleeves." }],
    rationale: "Deterministic fallback (no LLM key): nothing is executed without a live judgment.",
  };
}

/* ---------------------------------- Mint ---------------------------------- */

/** Prompted length budget for a launch's concept and rationale (each). */
export const LAUNCH_TEXT_BUDGET = 900;
/** Hard schema ceiling for the same fields; generous so long specs still land. */
export const LAUNCH_TEXT_SCHEMA_MAX = 3000;

export const launchSchema = z.object({
  launch: z
    .object({
      ...launchSpecShape,
      /* Schema ceilings sit well above the prompted budget (LAUNCH_TEXT_BUDGET)
         so a spec that runs long lands instead of failing the whole call: on
         2026-09-11 a 1300-char concept + rationale cost Mint a real gme-lane
         design ("Silent Rotation") and left the deterministic fallback in its
         place. The prompt asks for less; the schema forgives more. */
      concept: z.string().max(LAUNCH_TEXT_SCHEMA_MAX),
      rationale: z.string().max(LAUNCH_TEXT_SCHEMA_MAX),
      message: z
        .string()
        .min(10)
        .max(500)
        .describe(
          "The broadcast: the one statement LAURA is making with this launch, written in her voice to the humans watching new tokens in Telegram (e.g. an introduction, a milestone celebration, a grade move, a mission update toward $1B). If you cannot state what this launch says, skip the launch.",
        ),
      /* Free string on purpose (the renderer fuzzy-matches and falls back to
         chart), but the guidance is derived from the renderer's own motif
         list so new motifs reach Mint without touching this file. */
      artMotif: z
        .string()
        .min(2)
        .max(80)
        .describe(`Visual motif for the logo, e.g. ${ART_MOTIFS.join(", ")}`),
      artPalette: z.enum(ART_PALETTES),
      artStyle: z
        .enum(ART_STYLES)
        .describe(
          "Logo composition: orbital (spacefaring ring), poster (full-bleed glyph, title bar), badge (circular emblem), glitch (RGB-split terminal interference), minimal (huge ticker, thin frame).",
        ),
      imageQuery: z
        .string()
        .min(3)
        .max(100)
        .nullable()
        .describe(
          "Image search phrase for a REAL photo/image as the token logo — the browser worker fetches it with Chromium. Name the concrete visual subject of the concept (e.g. 'toll booth on a highway at night', 'red tape bureaucracy documents'), never the ticker or abstract finance words. STRONGLY PREFERRED for every launch; null only when no real-world image could carry the concept (then the procedural motif/palette/style art renders instead — it is also the automatic fallback if the search finds nothing).",
        ),
    })
    .nullable(),
  skipReason: z.string().max(300).nullable(),
});

export type LaunchOut = z.infer<typeof launchSchema>;

/**
 * What LAURA has said recently through launches, for the Mint prompt: keeps her
 * from repeating a statement and anchors the next message in the running story.
 */
export function spokenLaunchesDigest(launches: LaunchProposal[], limit = 8): string {
  const all = launches.filter((l) => l.status !== "rejected" && l.status !== "failed");
  const relevant = all.slice(-limit);
  if (relevant.length === 0) return "Nothing yet — LAURA has not spoken through a launch.";
  const lines = relevant.map((l) => {
    const when = new Date(l.deployedAt ?? l.createdAt).toISOString().slice(0, 10);
    const art = l.artMotif ? ` (art: ${l.artMotif}/${l.artPalette ?? "?"}/${l.artStyle ?? "seeded"})` : "";
    return `- ${when} · ${l.name} ($${l.symbol}) [${l.status}]${art}: ${stripLaunchSignoff(l.message ?? l.concept)}`;
  });
  /* Every distinctive word already spent across ALL launches (not just the
     shown window): the operator flagged recurring name material on
     2026-09-11 ("Opening Bell" then "After The Bell"; "Diamond Hands Lane"
     then "Thirty Four Thousand Hands"). The prompt bans reusing these. */
  const stop = new Set(["the", "and", "for", "with", "day", "days"]);
  const used = new Set<string>();
  for (const l of all) {
    for (const w of l.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !stop.has(w)) used.add(w);
    }
    used.add(l.symbol.toLowerCase());
  }
  lines.push(`NAME MATERIAL ALREADY SPENT (words used by ANY past launch name or symbol; never build a new name around these): ${[...used].sort().join(", ")}`);
  return lines.join("\n");
}

/**
 * What the pad's own history teaches: which launches graduated, which stalled,
 * and what separates them. Computed from the public launcher grid (all
 * creators, not just LAURA) so Mint learns parameter and concept choices from
 * real outcomes instead of guessing.
 */
export function padOutcomeStudy(recent: GridToken[], byVolume: GridToken[]): string {
  if (recent.length === 0 && byVolume.length === 0) return "No pad history available this cycle.";
  const now = Date.now();
  const dayMs = 86_400_000;
  /* The "new" sort carries degraded stats for graduated rows (mcap ~$0, 1
     holder — verified 2026-09-11), so base rates come from the recent sample
     and winner stats from the volume sort, where graduated tokens keep real
     mcap/holder numbers. */
  const stalled = recent.filter(
    (t) => !t.graduated && now - new Date(t.createdAt).getTime() > dayMs && t.curvePct < 10,
  );
  const gradCount = recent.filter((t) => t.graduated).length;
  const working = recent.length - gradCount - stalled.length;
  const winners = byVolume.filter((t) => t.graduated && t.holderCount > 1).sort((a, b) => b.holderCount - a.holderCount);
  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const lines = [
    `Recent sample (${recent.length} newest pad tokens, all creators): ${gradCount} graduated, ${stalled.length} stalled (>24h old, <10% curve), ${working} still working the curve — most launches die; yours must earn holders to be the exception.`,
  ];
  if (winners.length > 0) {
    const top = winners
      .slice(0, 3)
      .map((t) => `${t.name} ($${t.symbol}) mcap $${Math.round(t.mcapUsd).toLocaleString()}, ${t.holderCount} holders`)
      .join(" · ");
    lines.push(
      `All-time volume winners that bonded (study their shape, never their names): ${top}. Median holders — winners ${median(winners.map((t) => t.holderCount))} vs recent stalls ${median(stalled.map((t) => t.holderCount))}: holder distribution is what separates bonds from corpses. Design for reasons to hold.`,
    );
  } else {
    lines.push("No bonded winners visible this cycle: the bar for bonding is high — an achievable gradMcapUsd matters.");
  }
  return lines.join("\n");
}

export function mintPrompt(
  ctx: CycleContext,
  floor: string,
  pendingLaunches: number,
  spokenDigest: string,
  capacity: string,
  laneMenu: string,
  queueLimit = 2,
): string {
  return [
    `MISSION\n${missionDigest(ctx.mission)}`,
    `METRICS\n${metricsDigest(ctx.metrics)}`,
    `LIVE INTERNET INTEL (today's X mentions, Robinhood leadership activity, ETH context, the ROBINHOOD CHAIN LAUNCH RADAR, the MEME-STOCK MARKET read — tokenized-stock tape on this chain plus meme-stock tokens pulling volume on any chain plus what paid boosts are pitching — and the X MEME-STOCK PULSE of retail conversation; all real DexScreener and X reads from the last hour. Reason from what is actually pulling volume, and never copy a live token's name or symbol)\n${ctx.intel}`,
    `WORLD FEEDS (prediction markets, live sports, launcher tape, protocol economics, community chat — a launch can ride any of these; a hot Polymarket question or a live game is launch material)\n${ctx.world}`,
    `LANE MENU (quote lanes on the Smart Launch V2 pads — every launch picks ONE lane; the token trades against that lane's quote asset)\n${laneMenu}`,
    `RESEARCH BRIEF\n${briefDigest(ctx.brief)}`,
    `LAUNCHER FLOOR & PAD OUTCOME STUDY (live tokens plus what actually graduated vs stalled on this pad, all creators — learn scale, holder patterns and concept styles from real outcomes, never copy a name)\n${floor}`,
    `QUEUED LAURA LAUNCHES AWAITING AUTONOMOUS DEPLOY: ${pendingLaunches}`,
    `LAUNCH CAPACITY & TREASURY (real numbers — ground your skip/propose reasoning in these, not guesses; a proposal made while the deploy cap is exhausted simply queues until headroom returns)\n${capacity}`,
    `WHAT LAURA HAS ALREADY SAID (recent launches; never repeat a statement)\n${spokenDigest}`,
    `NO SIGN-OFF (operator directive 2026-09-12, hard rule): the concept and the message END WHEN THE THOUGHT ENDS. Never append "I am LAURA, an AI", never the "<thing> is <noun>, not a promise" closer, no disclaimers, no risk boilerplate, no disclosures about what LAURA is, no label. Earlier launches carried that tail; it was a defect the operator flagged, not a house style, and code now strips it. Every sentence in the concept and message must carry information about THIS token.`,
    `SWARM MEMORY\n${lessonsDigest(ctx.lessons, 6)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.mint ?? "None."}`,
    `LIBRARY (durable build knowledge; trust it — the launch playbook and verified wire formats live here)\n${ctx.library}`,
    `LAUNCHES ARE NOT DRAFTS: what you produce is a LAUNCH PROPOSAL — a launch spec that deploys autonomously within the code-level caps, with no operator approval gate. If your strategy text calls a launch a "DRAFT" awaiting human review, that language is obsolete: ignore it, and never label a launch or its name/concept as a draft.`,
    `HEALTHY-FLOOR TEST (adopted 2026-09-11 from your own proposed definition — this is now the number behind your skip condition). A LAURA token on the floor is HEALTHY only if ALL THREE hold: (1) it is still below graduation, (2) it shows at least one non-swarm buy in the trailing 24h (the floor/grid lines above show trades and holders — if you cannot see evidence of a fresh outside buy, it is not healthy), (3) its anti-snipe start tax has fully decayed to the postTax floor (compute: startTaxBps / taxDecayPerMinuteBps minutes since arming). A token failing ANY test does NOT block the next launch — the floor has room. A token passing all three is doing its job and does not need a sibling crowding it, unless the new launch says something genuinely different. This test refines the skip decision; it never overrides the real gates (dedupe, caps, nothing-new-to-say).`,
    `ADVANCED PAD OPTIONS (operator directive 2026-09-11 — the full customization surface is yours; every claim below was verified by createLaunch simulation on the live pads). First, know what you already have: the V2 Safe Launch pad IS the launcher's "Guaranteed Bond / anti snipe" launch family — official copy: "snipe tax up to 99% falling every minute, raise bonds at the bell", and at graduation "the LP position mints into the Safety Deposit Box, a permanent locker with no unlock and no admin key". Your anti-snipe start tax and the guaranteed bond are the same design: the decaying tax IS the fair-start window, and graduation IS the bond. New knobs verified ACCEPTED on-chain: eoaOnly true = anti-bot shield (contracts cannot buy); maxBuyPpm = per-wallet anti-snipe whale cap in ppm of supply (10000 = 1% per wallet; combine with the decaying tax for fair-start designs the message narrates); bondVenue 1 = graduate into the Uniswap V3 venue instead of the StonkUp CL locker (LP still locks, fee rights stay with LAURA); unsoldMode 1 = alternate unsold-supply behavior at bond (keep 0 without a stated reason). Modes verified REJECTED today (do not design around them): sellsEnabled false (buy-only) reverts BadEconomics() and openEnded false (closed window) reverts BadParam() on every pad in every combination — spec validation refuses both; if the launcher enables them later, the directive updates. Defaults remain right for most launches; deviate as a DESIGNED, DISCLOSED choice, not decoration. TRY ALL LANES over time: weth, stonk, usdg and each open stock lane should all see launches; the menu shows what you have neglected.`,
    `LENGTH BUDGET (hard): concept at most ${LAUNCH_TEXT_BUDGET} characters, rationale at most ${LAUNCH_TEXT_BUDGET} characters, message at most 400. Write tight: the concept is the broadcast body a Telegram reader scans, the rationale is your reasoning in a paragraph. A spec that runs long is truncated in review, never improved by it.\n\nDesign at most ONE launch spec for a Smart Launch V2 pad, or return launch: null with a skipReason. Set the lane field from the LANE MENU above and match it to the concept: a GME-lore token belongs on the gme lane, an AI/GPU angle on nvda, a rockets/space angle on spcx, consumer tech on aapl, oil/macro on uso, ecosystem plays on stonk, stable-quoted experiments on usdg — weth stays the general-purpose default when nothing else fits better. NEVER pick a lane marked CLOSED (stock lanes close on weekends; a weekend launch belongs on weth, stonk or usdg). Avoid repeating the same lane the last few launches used — the menu shows recent lanes. Pad bounds: start mcap $1,000-$1,000,000; graduation $50,000-$10,000,000 and at least 2x start; start tax 0-9900 bps decaying by taxDecayPerMinuteBps each minute; buffer >= 600s. The concept may come from ANYWHERE (operator directive 2026-09-11, Mint has wide latitude in what she launches): StonkBrokers lore, live market narrative, meme-stock culture, wider crypto culture, a live game or a prediction market resolving today, something the community asked for in chat, a deliberate economics experiment (a tax shape or lane nobody has tried), a milestone, a grade move, or a joke that genuinely lands. The only hard requirements are that the name/symbol are original and non-deceptive and that the launch carries a message. RESERVED NAMES (hard rule): the launcher floor and the Telegram deploy bot HIDE any launch whose name or symbol contains ${RESERVED_LAUNCH_NEEDLES.map((n) => `"${n}"`).join(", ")} in any spelling ("Clock In", "CLOCK-IN", "cl0ckin" all count, and a needle split across name and symbol counts too). Such a launch deploys, pays the fee, and is then invisible everywhere. Never propose one; code drops it before the queue.\n\nSPEAKING VIA TOKENS — launches ARE LAURA's public voice. Humans watch every new token appear in the community Telegram; the name, symbol and concept are her words. Every launch must carry a deliberate MESSAGE: fill the message field with the one statement this launch makes (introducing herself, celebrating a milestone, marking a grade move, signaling a mission update toward $1B). Craft the name as the headline of that statement, the symbol as its punchy ticker, and the concept as the broadcast body the audience reads. A launch with nothing to say is spam — skip instead.\n\nMEME-STOCK PRIORITY (operator directive) — lead with meme-stock culture, without being confined to it. StonkBrokers IS meme-stock lore on Robinhood's own chain: concepts should read like tickers on a trading terminal (symbols that feel like stock symbols), channel GME/AMC-era energy (diamond hands, the short squeeze, retail vs Wall Street, "apes together"), or riff on Robinhood/stock-token news from the live intel. A launch that fuses a meme-stock angle with a live narrative beats an abstract lore piece every time. Never use a real company's actual ticker as your symbol — evoke the culture, don't impersonate the security.\n\nDESIGN FOR VOLUME (operator directive 2026-09-11) — a launch is graded by the volume it pulls, and volume follows live narrative, not protocol statistics. Before you write a concept, read three things in LIVE INTERNET INTEL and cite them in your rationale: (1) the TOKENIZED-STOCK TAPE — which stock retail is actually trading on this chain today (a $20M GME day means the gme lane has buyers on it right now; a dead tape on a lane means no buyers); (2) the MEME-STOCK MARKET list and boosted pitches — which meme-stock narratives are pulling volume on any chain in the last 24h (a Solana or BSC meme-stock token doing millions is a narrative Robinhood Chain has not priced yet); (3) the X MEME-STOCK PULSE — the specific retail conversation of the day (tokenized-stock arms race, a squeeze, a pairing meme, a new listing). Riding one of those live currents with an original name and symbol, on the lane whose quote asset that crowd already holds, is your DEFAULT and strongest play. It is a preference, not a gate: a lore piece, a culture riff, a community-requested token, an event token or a designed economics experiment may launch without a live current when it has a clear message and a stated purpose. Name in the rationale which KIND of launch this is (live-current, lore, culture, event, community, experiment) and what you expect it to earn or teach, so the outcome study can grade each kind on its results.\n\nSTOCK-LANE EXPLORATION (operator directive 2026-09-10) — every LAURA launch so far used the weth lane; the operator wants the NEXT FEW launches to explore the STOCK lanes (gme, nvda, aapl, spcx, uso) whenever the menu shows them open. A launch quoted in a tokenized stock is the meme-stock priority made literal: a gme-lane token trades against actual GME stock tokens, LAURA's creator fees accrue in that stock, and the launch lives inside the stock's story natively instead of commenting on it from outside. Pick the stock lane whose story genuinely fits your concept (your symbol must still be original — the LANE supplies the real-stock exposure, your token supplies the new idea); do not force a mismatched concept onto a stock lane just to follow this directive, and never pick one marked CLOSED.\n\nCADENCE — there is NO daily launch limit (operator directive 2026-09-11): speak whenever there is something distinct worth saying, and keep the pipeline loaded. Propose a launch when a milestone hit, the grade moved meaningfully, a notable live event gives you material, the community asked, or an experiment is worth running — LAURA earns creator fees on every trade, so justified launches are also revenue, and the executor paces deploys about 20 minutes apart so each gets its own arrival. PRE-STAGE WHEN THE WINDOW IS SHUT: a pacing wait or a closed stock lane is NOT a reason to skip — check LAUNCH CAPACITY above for when the window reopens and propose the next launch NOW so it auto-deploys the minute it does. Check WHAT LAURA HAS ALREADY SAID above: never restate a message a recent launch already made. If nothing new is worth saying, skip with that reason — a justified silence grades better than a repeated line.

VARIETY — with no count cap, sameness is the failure mode. Across consecutive launches vary the KIND (live-current, lore, culture, event, community, experiment), the lane, the scale (start mcap from $1k experiments to $100k+ statements), the supply, and the tax shape; WHAT LAURA HAS ALREADY SAID and the LANE MENU show what the last few did, so pick something they did not.

NAMING VARIETY (operator directive 2026-09-11 — the names were reading as one voice on repeat). Three hard rules. (1) NEVER reuse a word from the NAME MATERIAL ALREADY SPENT list in WHAT LAURA HAS ALREADY SAID: "Opening Bell" then "After The Bell", and "Diamond Hands Lane" then "Thirty Four Thousand Hands", is the exact repetition the operator flagged — one bell, one hands, one of everything. (2) BREAK THE REGISTER: nearly every launch so far is trading-floor jargon (float, borrow, powder, print, rotation, sweep). Market language stays available, but across consecutive launches rotate registers deliberately — internet/meme culture, sports, space, food, mythology, machines, weather, small absurd objects — a name from an unexpected register that still lands the message beats the fifth floor-jargon name in a row. (3) RETIRE THE NUMBER-SUFFIX FORMULA: BELL09, PRINT322, HIKE62, BBL100, HANDS34K, 52HRS is a visible pattern; use a number in a symbol only when the number IS the story, not as a naming crutch.\n\nLOGO IMAGE (operator directive 2026-09-12 — the procedural logos were reading as one template; every launch now gets a REAL image). Fill imageQuery with a concrete visual search phrase for the token's subject — the browser worker runs a Chromium image search, picks a matching photo and crops it into the logo. Describe the THING, not the ticker: for a toll-road token "toll booth on a highway at night", for a bureaucracy token "red tape wrapped around documents". Specific and visual beats abstract every time ("golden retriever in a hard hat" finds a logo; "construction success" finds noise). Also choose artMotif (one word from: ${ART_MOTIFS.join(", ")}), artPalette (one of: ${ART_PALETTES.join(", ")}) and artStyle (one of: ${ART_STYLES.join(", ")}) to match the concept — this procedural tuple renders the fallback logo when the image search comes up empty, so it still matters. VARY everything across consecutive launches; WHAT LAURA HAS ALREADY SAID shows each recent launch's art tuple. If ${queueLimit}+ LAURA launches are already pending, skip.`,
    `TAX DESIGN (operator directive — the curve tax is a creative instrument, not just anti-snipe). Verified pad economics: 16.5% of EVERY taxed trade is push-paid to LAURA in the lane's quote token the moment the trade lands; on the stonk lane that income arrives as $STONKBROKER while every curve trade prints mission-token volume, so a stonk-lane launch with a purposeful persistent tax works the volume grade twice. Enforced ranges: startTaxBps 0-9900 decaying by taxDecayPerMinuteBps each minute; postTaxBps 100-500 — the pad REVERTS below 100, never propose less. DECAY RULE (pinned by simulation 2026-09-11, the pad reverts BadEconomics() otherwise): startTaxBps must be an EXACT MULTIPLE of taxDecayPerMinuteBps, and the decay window startTaxBps/taxDecayPerMinuteBps must be 10 to 99 minutes — 2000/200 (10 min), 2500/125 (20 min), 3000/50 (60 min) are valid; 2000/250 (8 min), 2000/400 (5 min), 1000/99 (not a multiple) all revert. Zero tax means zero decay. Pick the window first, then set decay = startTaxBps / window. Design the tax AS PART OF THE MESSAGE and name its purpose inside the concept or message: a toll token holding postTax near the 500 bps ceiling where the broadcast says what the toll funds; a fair-start token with a steep startTax and fast decay framed as the anti-sniper shield; a slow-burn token whose unusually slow decay IS the countdown the concept narrates. An unexplained heavy tax reads as a rug signal — every choice above the 100 bps floor must be stated and justified in the token's own words. Honesty rules unchanged: no return promises, no disclosures or sign-off lines about what LAURA is, and LAURA never buys her own tokens — her creator share may fund $STONKBROKER buys only.`,
    `FEE LIFECYCLE (verified on-chain; your launches are income-producing assets). Every launch you design earns in two phases. CURVE PHASE: 16.5% of every trade's tax is pushed to the treasury instantly in the lane's quote token (weth lane pays WETH, stonk pays $STONKBROKER, usdg pays USDG, stock lanes pay their stock token); the rare fallback ledger (creatorQuoteOwed) is flushed automatically. AFTER GRADUATION: the bonded pool is locked forever, but LAURA keeps the lock NFT that carries the fee claim, so she collects 80% of that pool's swap fees for as long as it trades. A graduated token is not a finished token: it is a permanent revenue stream, and graduation is an economic WIN, not just a status change. All claiming is automated: the executor checks every launch on every pass and claims whatever clears the dust threshold, so never spend words asking for a claim. What this means for YOUR design choices: (1) protocol revenue is a graded lever, and volume times tax equals income, so concepts that give people a reason to keep trading (a story that develops, a live event that resolves, a countdown) out-earn one-shot jokes; (2) lane choice decides which asset the treasury accrues, so weigh what the treasury wants to hold when two lanes fit the concept equally; (3) a curve designed to graduate converts a temporary tax stream into a permanent LP fee stream, so an achievable gradMcapUsd is itself a revenue decision.`,
  ].join("\n\n");
}

export function mintMock(ctx: CycleContext, pendingLaunches: number, queueLimit = 2): LaunchOut {
  if (pendingLaunches >= queueLimit) {
    return { launch: null, skipReason: "Launch queue already at its limit; keeping the queue tight." };
  }
  /* The fallback spec exists for keyless runs. With a live provider it means the
     model's output failed schema twice; a second Opening Bell would only be
     dropped as a duplicate downstream and hide the real cause in the summary. */
  if (ctx.llmProvider !== "mock") {
    return { launch: null, skipReason: "LLM launch output failed schema validation twice this cycle; no fallback spec is queued in place of a real design" };
  }
  const day = ctx.grade.date.replaceAll("-", "").slice(4);
  return {
    launch: {
      lane: "weth",
      name: "Opening Bell",
      symbol: `BELL${day.slice(0, 2)}`,
      supplyTokens: 1_000_000_000,
      startMcapUsd: 5_000,
      gradMcapUsd: 250_000,
      startTaxBps: 2500,
      taxDecayPerMinuteBps: 250,
      postTaxBps: 100,
      sellsEnabled: true,
      bufferSecs: 600,
      openEnded: true,
      eoaOnly: false,
      maxBuyPpm: 0,
      bondVenue: 0,
      unsoldMode: 0,
      concept:
        "A tribute to the launcher's VRNG Opening Bell buyback: the token that celebrates the moment the Buyback Bar fills and the bell rings. Ties directly into the launcher's own mechanic, so its story is the floor's story.",
      rationale:
        "Deterministic fallback spec (no LLM key). Fee flow from a curve token feeds the Buyback Bar and the launcher fee waterfall, which counts toward protocol revenue and volume - the two lagging grade levers.",
      message:
        "LAURA here. The bell on this floor rings when the Buyback Bar fills — this token is me ringing it on purpose. Watching the pot, working toward $1B.",
      artMotif: "bell",
      artPalette: "gold",
      artStyle: "orbital",
      imageQuery: "brass opening bell on a stock exchange floor",
    },
    skipReason: null,
  };
}

/* --------------------------------- Builder --------------------------------- */

export const builderSchema = z.object({
  /** At most ONE utility project per stride, or null with a skipReason. */
  project: z
    .object({
      /** Must be one of the candidate token addresses shown in the prompt. */
      tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      kind: z.enum(["faucet-drip", "burn-pledge", "holder-leaderboard", "gated-lore"]),
      title: z.string().min(5).max(120),
      concept: z.string().min(40).max(1200),
      /** One sentence a holder reads: what this gives the token. */
      utility: z.string().min(20).max(600),
      rationale: z.string().max(1200),
      /** True only when the build needs a bag (faucet). Burn/dashboard kinds do not. */
      wantsAcquisition: z.boolean(),
      /** Faucet only: suggested tokens per claim (the executor clamps it to the bag). */
      faucetClaimTokens: z.number().positive().nullable(),
      /** Faucet only: hours between claims per wallet (1 to 168). */
      faucetIntervalHours: z.number().min(1).max(168).nullable(),
    })
    .nullable(),
  skipReason: z.string().max(300).nullable(),
});

export type BuilderOut = z.infer<typeof builderSchema>;

export function builderPrompt(
  ctx: CycleContext,
  candidates: string,
  projects: string,
  capacity: string,
): string {
  return [
    `MISSION\n${missionDigest(ctx.mission)}`,
    `METRICS\n${metricsDigest(ctx.metrics)}`,
    `LAURA'S LAUNCHED TOKENS ELIGIBLE FOR A UTILITY BUILD (the ONLY tokens you may pick; address must match exactly)\n${candidates}`,
    `EXISTING UTILITY PROJECTS (never build twice for the same token; learn from what shipped)\n${projects}`,
    `BUILD CAPACITY (real numbers; ground your skip/propose reasoning in these)\n${capacity}`,
    `SWARM MEMORY\n${lessonsDigest(ctx.lessons, 6)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.builder ?? "None."}`,
    `LIBRARY (durable build knowledge; the builder playbook lives here)\n${ctx.library}`,
    `Design at most ONE utility project for one of the eligible tokens above, or return project: null with a skipReason. You give LAURA's launched tokens real function using ONLY the four allowlisted builds:\n- faucet-drip: deploys the audited ownerless FaucetDrip template and funds it with a tiny acquired bag; anyone claims a capped drip on an interval. Needs wantsAcquisition: true.\n- burn-pledge: deploys the audited ownerless BurnPledge template; holders burn tokens to write a permanent on-chain pledge line. No acquisition needed.\n- holder-leaderboard: a dashboard surface ranking holders; no chain action, ships from swarm state.\n- gated-lore: a dashboard lore page whose full text renders only for holders (viewer-side balance check); no chain action.\n\nSELECTION DISCIPLINE: prefer tokens with real traction (trades, a bonded pool) where a utility rewards actual holders; skipping is the right call when no token has earned a build yet. Never pick a token already served. Acquisitions are capped in code (per buy, per day, cooldown) and exist ONLY to fund the utility (charter rule 8); never frame them as price support. Custom contracts are impossible: the executor refuses anything outside the two shipped templates.`,
  ].join("\n\n");
}

export function builderMock(): BuilderOut {
  return {
    project: null,
    skipReason: "Deterministic fallback (no LLM key): utility builds are curated, not automatic; waiting for a token with real traction.",
  };
}

/* ---------------------------------- Coach --------------------------------- */

export function coachPrompt(ctx: CycleContext): string {
  const roster = ctx.agents
    .filter((a) => a.id !== "coach")
    .map((a) => {
      const perf =
        a.gradeAtVersionAdoption !== null
          ? `Grade when v${a.strategyVersion} went live: ${a.gradeAtVersionAdoption.toFixed(1)}; now ${ctx.grade.score.toFixed(1)}.`
          : `v${a.strategyVersion} is the original strategy.`;
      const past = a.history
        .slice(-3)
        .map(
          (h) =>
            `v${h.version}: ${h.gradeAtAdoption?.toFixed(1) ?? "?"} -> ${h.gradeAtRetirement?.toFixed(1) ?? "?"} (${h.reason})`,
        )
        .join("; ");
      const noDraftRole: Partial<Record<Agent["id"], string>> = {
        scout: "scout outputs the research brief, not drafts; 0 drafts is by design, not a failure",
        watcher: "watcher outputs the on-chain headline and alerts, not drafts; 0 drafts is by design",
        critic: "critic outputs vetoes and observations, not drafts",
      };
      const statsNote = noDraftRole[a.id]
        ? `Stats: N/A — ${noDraftRole[a.id]}.`
        : `Stats: ${a.stats.drafts} drafts, ${a.stats.approved} approved, ${a.stats.rejected} rejected.`;
      const lengthNote = `${a.strategy.length} chars${a.strategy.length > STRATEGY_BUDGET_CHARS ? ` — OVER the ${STRATEGY_BUDGET_CHARS} budget; any revision must condense it` : ""}`;
      return `### ${a.id} (${a.name}, v${a.strategyVersion})\n${statsNote} ${perf}${past ? ` Past versions: ${past}` : ""}\nStrategy (${lengthNote}):\n${a.strategy}\nReviewer decisions:\n${reviewerFeedback(ctx.drafts, a.id)}`;
    })
    .join("\n\n");
  return `MISSION\n${missionDigest(ctx.mission)}\n\nGRADES (last 7)\n${gradeDigest(ctx.grades)}\n\nTODAY\n${ctx.grade.summary}\n${ctx.grade.components.map((c) => `- ${c.label}: ${c.score.toFixed(0)} - ${c.detail}`).join("\n")}\n\nOPERATIONAL HEALTH (recent cycles; slow cycles, LLM fallbacks and error steps are problems you own)\n${ctx.opsHealth}\n\nTHE ACCOUNT ON X (what @LAURA_DAIO posted and how each post measured; the X voice study rewrites the x-voice skill from this every few hours, so lessons here should name the shape that won or lost, with its numbers)\n${ctx.xPosted}\n\nEXISTING SWARM MEMORY\n${lessonsDigest(ctx.lessons)}\n\nYOUR SKILLS (operating procedures; follow them)\n${ctx.skills.coach ?? "None."}\n\nLIBRARY (durable build knowledge; strategies you propose must stay consistent with it)\n${ctx.library}\n\nROSTER\n${roster}\n\nFirst, distil up to three NEW lessons (durable, evidence-backed, not already in memory) about what moves the grade or what reviewers accept. Second, optionally record up to two NOTEBOOK entries: durable reference knowledge (verified mechanics, numbers worth remembering, operator context) as opposed to tactical lessons. Writing an existing notebook topic replaces it — use that to keep facts current. LENGTH BUDGET (hard): each lesson text and each notebook entry text at most ${NOTE_TEXT_BUDGET} characters, evidence at most 600; a lesson is one finding with its proof, not an essay. Third, propose revised strategy text for at most two agents. Return the complete replacement strategy, not a diff. LENGTH BUDGET: a strategy is an operating brief, not a changelog — the replacement must be at most ${STRATEGY_BUDGET_CHARS} characters (the roster shows each strategy's current length). Never append an "Added in vN" block to an already long strategy; condense what stays, delete what no longer earns its place, and fold the change into the body. A strategy that already carries duplicated paragraphs is your first target: merge them. COVERAGE (operator directive 2026-09-11: every agent evolves, not only the draft producers): the roster shows each agent's version — when an agent is still on v1 after many cycles (watcher, critic, vault, builder, sage, the intel voices) and you hold concrete evidence about its output (skipped strides, vetoes that missed a pattern, Cafe Bar posts that repeat, a launch that pulled no volume), prefer revising THAT agent over a fifth revision of bd or narrative. Mint's evidence is the pad outcome — 24h volume and non-swarm holders of LAURA's own launches versus the MEME-STOCK MARKET currents it could have ridden. Never remove factual grounding or charter compliance. Standing disclaimers, risk boilerplate, AI disclosures and "official content" labels are retired from all posts (operator directive 2026-09-12): strip any strategy clause that mandates them, never add one. Fourth, optionally return ONE skillEdit to create or replace a skill file in /library/skills — use it when an operating procedure (not a strategy) has proven wrong, missing or stale: the full replacement body ships to every listed agent's prompts from the next cycle. Reuse an existing skill name to update it; only edit a skill when you have concrete evidence its current text misleads, and keep every verified fact it contains. Otherwise return skillEdit: null.`;
}

/* --------------------------------- Forge ---------------------------------- */

/**
 * Forge's upgrade queue (operator directive 2026-09-11: "add one more swarm
 * agent that helps upgrade all the agents"): deterministic, coverage-first.
 * The least-upgraded agents come first (lowest strategy version, then oldest
 * adoption), so the intel voices and other v1 stragglers get attention before
 * a seventeenth revision of bd. cycleSeq rotates tie order so equal-version
 * agents take turns instead of the same pair monopolizing the slot.
 */
export function trainerTargets(agents: Agent[], cycleSeq: number, count = 2): Agent[] {
  const pool = agents.filter((a) => a.id !== "trainer" && a.status !== "paused");
  if (pool.length === 0) return [];
  const rot = cycleSeq % pool.length;
  const rotated = [...pool.slice(rot), ...pool.slice(0, rot)];
  /* Stable sort: rotation order breaks ties within a version/adoption class. */
  return rotated
    .sort((a, b) => a.strategyVersion - b.strategyVersion || (a.versionAdoptedAt ?? 0) - (b.versionAdoptedAt ?? 0))
    .slice(0, count);
}

export const trainerSchema = z.object({
  /** Full replacement strategies for the assigned targets; skip instead when the record supports the incumbent. */
  upgrades: z
    .array(
      z.object({
        agentId: z.enum(["scout", "watcher", "researcher", "narrative", "steward", "bd", "analyst", "growth", "vault", "critic", "mint", "builder", "coach", "sage", "smartlp", "nftintel", "tokenintel", "treasurer"]),
        proposedStrategy: z.string().min(80).max(STRATEGY_SCHEMA_MAX),
        rationale: z.string().max(1500),
        evidence: z.array(z.string().max(500)).min(1).max(6),
      }),
    )
    .max(2),
  /** Recorded verdicts for targets left in place: proof the strategy is performing, not neglect. */
  skips: z
    .array(
      z.object({
        agentId: z.string().max(24),
        reason: z.string().min(10).max(500),
      }),
    )
    .max(2),
});

export type TrainerOut = z.infer<typeof trainerSchema>;

export function trainerPrompt(ctx: CycleContext, targets: Agent[]): string {
  const noDraftRole = new Set(["scout", "watcher", "critic", "vault", "treasurer", "mint", "builder", "coach", "sage", "smartlp", "nftintel", "tokenintel"]);
  const dossiers = targets
    .map((a) => {
      const perf =
        a.gradeAtVersionAdoption !== null
          ? `Grade when v${a.strategyVersion} went live: ${a.gradeAtVersionAdoption.toFixed(1)}; now ${ctx.grade.score.toFixed(1)}.`
          : `v${a.strategyVersion} is the original seed strategy — it has NEVER been revised.`;
      const past = a.history
        .slice(-3)
        .map((h) => `v${h.version}: ${h.gradeAtAdoption?.toFixed(1) ?? "?"} -> ${h.gradeAtRetirement?.toFixed(1) ?? "?"} (${h.reason})`)
        .join("; ");
      const statsNote = noDraftRole.has(a.id)
        ? `Stats: this role's output is not drafts (briefs, alerts, vetoes, launches, memos or library writes); judge it by its recent output digest and role fit, 0 drafts is by design.`
        : `Stats: ${a.stats.drafts} drafts, ${a.stats.approved} approved, ${a.stats.rejected} rejected.`;
      return [
        `### TARGET ${a.id} (${a.name}) — ${a.role}`,
        `${statsNote} ${perf}${past ? ` Past versions: ${past}` : ""}`,
        `Current strategy v${a.strategyVersion} (${a.strategy.length} chars${a.strategy.length > STRATEGY_BUDGET_CHARS ? ` — OVER the ${STRATEGY_BUDGET_CHARS} budget, a rewrite must condense it` : ""}):\n${a.strategy}`,
        `Recent output:\n${recentOutputDigest(ctx.drafts, a.id, 2)}`,
        `Reviewer decisions:\n${reviewerFeedback(ctx.drafts, a.id)}`,
      ].join("\n");
    })
    .join("\n\n");
  return [
    `MISSION\n${missionDigest(ctx.mission)}`,
    `GRADES (last 7)\n${gradeDigest(ctx.grades)}`,
    `TODAY\n${ctx.grade.summary}`,
    `SWARM MEMORY (lessons the whole swarm has already banked; upgrades must build on these, not rediscover them)\n${lessonsDigest(ctx.lessons)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.trainer ?? "None."}`,
    `YOUR ASSIGNED TARGETS THIS RUN (chosen in code: the roster's least-upgraded agents — you do not pick targets, you work the queue)\n${dossiers}`,
    `For EACH target, deliver a verdict: an upgrade (full replacement strategy) or a recorded skip (evidence the incumbent strategy is performing). UPGRADE RULES: return the COMPLETE replacement text, not a diff; keep what the record shows working, delete what it contradicts, add at most two new tactics each tied to cited evidence (a reviewer decision, a grade move, a repeated failure in the output digest, a banked lesson). LENGTH BUDGET (hard): at most ${STRATEGY_BUDGET_CHARS} characters — a strategy is an operating brief, never a changelog; never append "Added in vN" blocks. Never weaken the charter, never remove factual grounding or hard-cap references, never change what channels an agent may write to. Standing disclaimers, risk boilerplate, AI disclosures and "official content" labels are retired from all posts (operator directive 2026-09-12): strip any strategy clause that mandates them, never add one. A v1 seed strategy that has never been revised almost always deserves an upgrade: it was written before any evidence existed. SKIP RULES: a skip needs specific evidence of current performance (recent outputs doing their job, approvals, a grade component this agent moves), not politeness.`,
  ].join("\n\n");
}

export function trainerMock(targets: Agent[]): TrainerOut {
  return {
    upgrades: [],
    skips: targets.slice(0, 2).map((t) => ({
      agentId: t.id,
      reason: `Deterministic fallback (no LLM key): a strategy rewrite needs a live model reading the record; v${t.strategyVersion} stays in place until the next pass.`,
    })),
  };
}

/* ---------------------------------- Sage ----------------------------------- */

/**
 * Sage's pass rotation: one deep pass per strided run, chosen deterministically
 * from the run count so the four passes interleave without state or an extra
 * LLM call. distill and study grow shared context, audit sharpens one agent,
 * curate keeps the library itself healthy.
 */
export const SAGE_PASSES = ["distill", "study", "audit", "curate"] as const;
export type SagePass = (typeof SAGE_PASSES)[number];

export function sagePassForRun(runs: number): SagePass {
  return SAGE_PASSES[runs % SAGE_PASSES.length];
}

/** Deterministic audit-target rotation: every non-sage agent gets its turn under the lens. */
export function sageAuditTarget(agents: Agent[], runs: number): Agent | null {
  const pool = agents.filter((a) => a.id !== "sage");
  if (pool.length === 0) return null;
  return pool[Math.floor(runs / SAGE_PASSES.length) % pool.length];
}

/** The ledger doc Sage maintains; every agent receives it through the library digest. */
export const SAGE_LEDGER_FILE = "65-collective-intelligence.md";

/* Generous caps (library learnings: tight caps cause NoObjectGenerated failures). */
export const sageSchema = z.object({
  /** Headline for the pass memo, written as a real finding, not a template label. */
  title: z.string().min(8).max(160),
  /** The pass's core output, written FOR the other agents: what to do differently and why. */
  insight: z.string().min(100).max(8000),
  /**
   * Optional write to ONE library doc (full replacement body). The write path
   * (writeLibraryDoc) enforces the allowlist in code: numbered kebab-case .md
   * inside /library only, operator docs denied, doc count capped.
   */
  libraryEdit: z
    .object({
      file: z.string().regex(/^[1-9][0-9]-[a-z0-9][a-z0-9-]{1,58}\.md$/),
      body: z.string().min(80).max(9000),
      rationale: z.string().min(10).max(600),
    })
    .nullable(),
  /** Optional skill create/replace, same constrained channel the coach uses. */
  skillEdit: skillEditSchema.nullable(),
  /** Durable reference knowledge; an existing topic is replaced, not duplicated. */
  notebook: z
    .array(
      z.object({
        topic: z.string().min(3).max(120),
        text: z.string().min(20).max(NOTE_TEXT_SCHEMA_MAX),
      }),
    )
    .max(2),
});

export type SageOut = z.infer<typeof sageSchema>;

export interface SageInputs {
  pass: SagePass;
  /** Full current text of the collective intelligence ledger doc. */
  ledger: string;
  /** Recent friction events: novelty rejections, critic vetoes, step errors. */
  frictions: string;
  /** The Cafe Bar digest: what agents are confused by or debating right now. */
  forum: string;
  /** Audit pass only: the agent under the lens and its record. */
  audit: { agent: Agent; recentOutput: string; feedback: string } | null;
  /** Curate pass only: every library doc with its size and protection state. */
  libraryIndex: string;
}

function sagePassBlock(inputs: SageInputs): string {
  switch (inputs.pass) {
    case "distill":
      return [
        `YOUR PASS THIS RUN: DISTILL. Read the operational record above (runs, frictions, grades, lessons, the bar) and find the ONE most load-bearing pattern the swarm keeps living but has not yet named: a class of veto that keeps recurring, a question agents keep asking each other in the bar, a mismatch between what gets graded and what gets produced. Compress it into a durable, actionable entry and write it into the ledger via libraryEdit (file ${SAGE_LEDGER_FILE}): return the FULL updated doc body, keep every existing entry, and add yours dated at the TOP of the insight ledger section. The digest ships roughly the first 3,000 chars of the doc to every agent, so newest entries must lead and the doc should stay near that size: compress the OLDEST entries into the condensed section rather than deleting them. One sharp insight beats three vague ones.`,
      ].join("\n\n");
    case "study":
      return [
        `YOUR PASS THIS RUN: STUDY. Pick ONE external idea and translate it into a concrete practice for THIS swarm. Sources: something real from the live intel or world feeds, or established knowledge you already hold about agent architectures, prompting techniques, memory patterns, market microstructure or growth theory. The test is transfer: name the idea, name its source or lineage in one line, then specify exactly how an agent here applies it next cycle (which agent, which step, what changes in its output). Write the practice into the ledger via libraryEdit (file ${SAGE_LEDGER_FILE}, full updated body, keep existing entries, newest at the top of the insight section, compress the oldest into the condensed section once the doc passes roughly 3,000 chars), or, when the idea is a step-by-step operating procedure for specific agents, ship it as a skillEdit instead. Never study an idea the ledger already contains.`,
      ].join("\n\n");
    case "audit":
      return inputs.audit
        ? [
            `YOUR PASS THIS RUN: AUDIT of ${inputs.audit.agent.name} (${inputs.audit.agent.id}).`,
            `THEIR CURRENT STRATEGY (v${inputs.audit.agent.strategyVersion})\n${inputs.audit.agent.strategy}`,
            `THEIR RECENT OUTPUT\n${inputs.audit.recentOutput}`,
            `REVIEWER DECISIONS ON THEIR WORK\n${inputs.audit.feedback}`,
            `Judge the outputs against the strategy and the mission grade: where does this agent leave value on the table, repeat itself, or misread its inputs? Write ONE targeted coaching note as a notebook entry with topic "Coaching: ${inputs.audit.agent.id}" (replacing any earlier note for the same agent) stating the specific behavior to change and the evidence. If you found a wrong or missing OPERATING PROCEDURE (not a strategy question, that is the coach's lane), fix it with a skillEdit scoped to that agent. Leave libraryEdit null unless the finding generalizes to the whole swarm.`,
          ].join("\n\n")
        : `YOUR PASS THIS RUN: AUDIT, but no target agent is available. Record what you can from the operational record as a notebook entry and return libraryEdit and skillEdit as null.`;
    case "curate":
      return [
        `YOUR PASS THIS RUN: CURATE the library itself.`,
        `LIBRARY FILE INDEX (sizes matter: every doc shares one digest budget, and oversized docs get trimmed in every agent's prompt)\n${inputs.libraryIndex}`,
        `Pick the ONE doc whose current text most misleads or bloats the digest (overlapping guidance, stale numbers, buried operating rules) and rewrite it via libraryEdit with the full replacement body. HARD RULES: docs marked PROTECTED are operator-owned and the write path rejects them, never target those; keep every verified fact and every operator directive in whatever you rewrite; make changes additive or clearly versioned (add a line "Revised by Sage on <date>: <what changed>" at the top of any doc you touch); never delete another agent's recorded learnings, condense them instead. If the shelf is genuinely healthy, return libraryEdit null and say why in the insight.`,
      ].join("\n\n");
    default: {
      const _exhaustive: never = inputs.pass;
      return _exhaustive;
    }
  }
}

export function sagePrompt(ctx: CycleContext, inputs: SageInputs): string {
  return [
    `TODAY (UTC): ${ctx.grade.date}.`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `GRADES (last 7)\n${gradeDigest(ctx.grades)}`,
    `OPERATIONAL RECORD (recent cycles: durations, fallbacks, errors)\n${ctx.opsHealth}`,
    `RECENT FRICTIONS (vetoes, novelty rejections, failures: raw material for insight)\n${inputs.frictions}`,
    `THE CAFE BAR (what agents are actually confused by or debating; doctrine tells them to surface confusion here for YOU)\n${inputs.forum}`,
    `SWARM MEMORY (the coach's lessons; do not duplicate these)\n${lessonsDigest(ctx.lessons)}`,
    `LIVE INTERNET INTEL\n${ctx.intel}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.sage ?? "None."}`,
    `LIBRARY (what every agent already receives; your ledger ${SAGE_LEDGER_FILE} is part of it)\n${ctx.library}`,
    `CURRENT LEDGER TEXT (${SAGE_LEDGER_FILE}, verbatim; libraryEdit bodies for this file must keep its structure and existing entries. The digest carries roughly the doc's first 3,000 chars to every agent, so the insight section leads the doc and newest entries lead the section)\n${inputs.ledger || "The ledger does not exist yet; create it."}`,
    sagePassBlock(inputs),
    `WRITE CHANNELS, HARD RULES: your only levers are libraryEdit (numbered .md docs in /library; the operator docs 10-operator.md and 20-project.md are denied in code), skillEdit (/library/skills, 18 file cap, full replacement), and notebook entries (each at most ${NOTE_TEXT_BUDGET} characters). You never touch code, caps, guards, executor logic or safety machinery, and you never propose doing so. Whatever you write becomes prompt context for every agent next cycle, so write instructions an agent can act on, with evidence, not observations. STYLE: plain sentences with commas, colons and periods; never an em dash, never a dash-spliced clause; "onchain" not "on-chain" in prose. The title is a real headline stating the finding, never a template label.`,
  ].join("\n\n");
}

export function sageMock(inputs: SageInputs): SageOut {
  return {
    title: `Collective intelligence pass held: no model available for the ${inputs.pass} pass`,
    insight:
      `Deterministic fallback (no LLM key this run). The ${inputs.pass} pass needs live judgment, and writing generic filler into shared context would make every agent slightly worse, so this run records nothing. The pass rotation stands: the next sage run retries with the same inputs plus fresher data. Frictions and bar threads remain queued as raw material.`,
    libraryEdit: null,
    skillEdit: null,
    notebook: [],
  };
}

export function coachMock(ctx: CycleContext): ProposalsOut {
  const weakest = [...ctx.grade.components].sort((a, b) => a.score - b.score)[0];
  const candidates = ctx.agents.filter((a) => a.id !== "coach" && a.id !== "scout");
  const target =
    candidates.find((a) => a.stats.rejected > a.stats.approved) ??
    (weakest.key === "revenue" || weakest.key === "volume"
      ? candidates.find((a) => a.id === "bd")
      : candidates.find((a) => a.id === "narrative"));
  const lessons: ProposalsOut["lessons"] = [];
  if (ctx.lessons.length === 0) {
    lessons.push({
      text: "Anchor every piece in one live number from the metrics digest; unsourced claims are the fastest way to a rejection.",
      evidence: "Charter rule 4; grader weights price/revenue/volume at 85%",
    });
  }
  if (weakest.key === "price" && !ctx.lessons.some((l) => l.text.includes("liquidity"))) {
    lessons.push({
      text: "When price is the weakest lever, explain liquidity depth and the fixed 666,666 swap unit rather than commenting on the move itself.",
      evidence: `price component ${weakest.score.toFixed(0)}/100 today`,
    });
  }
  if (!target) return { lessons, notebook: [], proposals: [], skillEdit: null };
  const addition =
    weakest.key === "price"
      ? "Lead with the fixed 666,666 $STONKBROKER swap unit and current pool depth so readers understand why liquidity, not hype, sets the path into a broker."
      : weakest.key === "revenue"
        ? "Prioritise surfaces that generate ETH fees (Anvil swaps, loans, lockers) and always state the current 24h fee figure with its DefiLlama source."
        : weakest.key === "volume"
          ? "Aim each piece at one concrete flow-routing counterparty (aggregator, launchpad user, LP) and name the next step they can take this week."
          : "Tighten to the formats reviewers approved most recently and drop any section that was rejected twice.";
  /* The fallback is deterministic, so it must be idempotent: if this exact
     addition is already in the strategy, or the strategy has no room left,
     propose nothing rather than stack identical "Added in vN" blocks. */
  if (target.strategy.includes(addition) || target.strategy.length + addition.length + 40 > STRATEGY_BUDGET_CHARS) {
    return { lessons, notebook: [], proposals: [], skillEdit: null };
  }
  return {
    lessons,
    notebook: [],
    proposals: [
      {
        agentId: target.id as ProposalsOut["proposals"][number]["agentId"],
        proposedStrategy: `${target.strategy}\n\nAdded in v${target.strategyVersion + 1}: ${addition}`,
        rationale: `Deterministic fallback proposal. ${weakest.label} is the weakest grade component (${weakest.score.toFixed(0)}/100); ${target.name} is best placed to move it.`,
        evidence: [
          `Grade component ${weakest.key} = ${weakest.score.toFixed(0)}`,
          `${target.name}: ${target.stats.approved} approved / ${target.stats.rejected} rejected`,
        ],
      },
    ],
    skillEdit: null,
  };
}
