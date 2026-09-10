import { z } from "zod";
import type {
  Agent,
  DailyGrade,
  Draft,
  DraftKind,
  LaunchProposal,
  Lesson,
  MetricsSnapshot,
  ResearchBrief,
  Settings,
} from "@/lib/types";
import { missionDigest, type MissionStatus } from "@/lib/mission-status";
import { ART_PALETTES, launchSpecShape } from "@/lib/launchpad/spec";
import { SWARM_CHARTER } from "@/lib/swarm/roster";
import {
  briefDigest,
  gradeDigest,
  metricsDigest,
  pct,
  recentOutputDigest,
  reviewerFeedback,
  usd,
} from "@/lib/swarm/context";

/* Generous caps: providers write long; hard failures cost a whole agent turn.
   Anything display-constrained is truncated at the point of use instead. */
export const briefSchema = z.object({
  headline: z.string().max(400),
  bullets: z.array(z.string().max(700)).min(2).max(8),
});

export const draftSchema = z.object({
  kind: z.enum(["thread", "article", "community", "outreach", "report", "video-script"]),
  channel: z.string().max(100),
  title: z.string().max(300),
  body: z.string().max(20000),
  rationale: z.string().max(1200),
});

export const draftsSchema = z.object({ drafts: z.array(draftSchema).min(1).max(3) });

export const proposalsSchema = z.object({
  lessons: z
    .array(
      z.object({
        text: z.string().min(20).max(700),
        evidence: z.string().max(500),
      }),
    )
    .max(3),
  /** Durable reference knowledge for the notebook; same topic replaces the old entry. */
  notebook: z
    .array(
      z.object({
        topic: z.string().min(3).max(80),
        text: z.string().min(20).max(700),
      }),
    )
    .max(2),
  proposals: z
    .array(
      z.object({
        agentId: z.enum(["scout", "researcher", "narrative", "steward", "bd", "analyst", "growth", "critic", "mint"]),
        proposedStrategy: z.string().min(80).max(4000),
        rationale: z.string().max(1500),
        evidence: z.array(z.string().max(500)).min(1).max(6),
      }),
    )
    .max(2),
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

/* ---------------------------------- Scout --------------------------------- */

export function scoutPrompt(ctx: CycleContext): string {
  return `MISSION\n${missionDigest(ctx.mission)}\n\nMETRICS\n${metricsDigest(ctx.metrics)}\n${ctx.priceTrend}\n\nGRADES (last 7)\n${gradeDigest(ctx.grades)}\n\nSWARM MEMORY\n${lessonsDigest(ctx.lessons, 6)}\n\nYOUR SKILLS (operating procedures; follow them)\n${ctx.skills.scout ?? "None."}\n\nLIBRARY (durable build knowledge; trust it)\n${ctx.library}\n\nDOCS EXCERPT\n${ctx.docs}\n\nProduce the research brief.`;
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
        ? `On-chain: Clock In pot holds ${m.onchain.clockInPotEth.toFixed(3)} ETH (${usd(m.onchain.clockInPotUsd)}); ${m.onchain.brokersInCirculation} of 4444 brokers are in holders' hands, ${m.onchain.brokersInVault} sit in the Anvil vault.`
        : `Weakest grade lever: ${weakest.label.toLowerCase()} (${weakest.score.toFixed(0)}/100). Caveat: DexScreener aggregates ${m.pairCount} pairs, some near-empty; quote liquidity-weighted figures only.`,
    ],
  };
}

/* ---------------------------- Content producers --------------------------- */

const KIND_BY_AGENT: Record<string, DraftKind[]> = {
  narrative: ["thread", "article"],
  steward: ["community"],
  bd: ["outreach"],
  analyst: ["report"],
  growth: ["thread"],
};

export function producerPrompt(agent: Agent, ctx: CycleContext): string {
  const kinds = KIND_BY_AGENT[agent.id] ?? ["thread"];
  return [
    `TODAY (UTC): ${ctx.grade.date}. Use this date; never invent another.`,
    `METRICS\n${metricsDigest(ctx.metrics)}`,
    `TODAY'S GRADE\n${ctx.grade.summary}\n${ctx.grade.components.map((c) => `- ${c.label}: ${c.score.toFixed(0)}/100 - ${c.detail}`).join("\n")}`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `RESEARCH BRIEF\n${briefDigest(ctx.brief)}`,
    `SWARM MEMORY (lessons distilled by the coach; apply them)\n${lessonsDigest(ctx.lessons)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills[agent.id] ?? "None."}`,
    `LIBRARY (durable build knowledge; trust it)\n${ctx.library}`,
    `RECENT REVIEWER DECISIONS ON YOUR WORK\n${reviewerFeedback(ctx.drafts, agent.id)}`,
    `YOUR OWN RECENT OUTPUT (do NOT repeat these themes or angles)\n${recentOutputDigest(ctx.drafts, agent.id)}`,
    `DOCS EXCERPT (for factual grounding)\n${ctx.docs.slice(0, 3500)}`,
    `Produce ${kinds.length} draft(s) of kind(s): ${kinds.join(", ")}. Each draft needs a channel (e.g. "X", "Discord", "Blog", "Email", "Notion"), a title, the full body, and a one-paragraph rationale linking it to the lagging grade lever.`,
    `ANTI-REPETITION RULE: your new drafts must differ from every item in YOUR OWN RECENT OUTPUT in theme, angle or surface — pick a different product surface, audience, format or hook, or explicitly supersede an earlier piece with materially new data (and say so in the rationale). Near-duplicates are rejected in code before review and waste your turn. In the rationale, name in one clause how this differs from your last outputs.`,
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
            kind: "thread",
            channel: "X",
            title: "How a StonkBroker turns fees into stock",
            body: [
              `1/ Every StonkBroker NFT on Robinhood Chain owns a wallet (ERC-6551). Activate it and it becomes eligible for stock-token drops funded by protocol fees. Here is the loop, with today's numbers.`,
              `2/ Anvil NFT AMM: swap 666,666 $STONKBROKER + an ETH fee for the next broker in the vault, or snipe an exact # for a higher fee. 70% of that ETH fee goes to the Stock Booster pot, 30% to the protocol.`,
              `3/ Activation is paid in $STONKBROKER, tiered by broker. 50% of every activation fee is burned. Selling or transferring clears activation, so the new owner reactivates.`,
              `4/ When the pot fills, any wallet can Clock In. The round's ETH swaps into the configured stock token (TSLA, NVDA, AMZN...) and airdrops to activated brokers, weighted by tier.`,
              `5/ Last 24h: protocol fees ${usd(m.protocolFees24hUsd)}, protocol revenue ${usd(m.protocolRevenue24hUsd)}, protocol volume ${usd(m.protocolVolume24hUsd)}. Source: DefiLlama.`,
              `6/ These are smart-contract distributions funded by fees, not dividends or equity. Stock-token features are unavailable in the US. Docs: stonkbrokers.cash/docs`,
            ].join("\n\n"),
            rationale,
          },
          {
            kind: "article",
            channel: "Blog",
            title: "Reading the Stonk Exchange dashboard like an integrator",
            body: `The StonkBrokers stack publishes three numbers that matter more than the token chart: protocol fees, protocol revenue and protocol volume. Today they read ${usd(m.protocolFees24hUsd)}, ${usd(m.protocolRevenue24hUsd)} and ${usd(m.protocolVolume24hUsd)} over 24 hours, against a 7-day daily average of ${usd(m.protocolRevenue7dUsd / 7)} in revenue.\n\nFees are the ETH paid on Anvil AMM swaps and NFT-backed loans plus $STONKBROKER activation and upgrade fees. Revenue is the portion retained by the protocol after the 70/30 split into the Stock Booster pot. Volume is notional traded across every surface, from Anvil fills to Broker Box tickets to Stonk Launcher window buys.\n\nWhy does an integrator care? Because the Clock In distribution is a function of fees, not of price. A wallet, aggregator or launchpad that routes flow through the Anvil AMM or the up.-powered vDEX directly increases the pot that activated brokers share. The Safety Deposit Box lockers route 90% of their fees to the community side of that same rail.\n\nThe $STONKBROKER token sits at ${usd(m.priceUsd, 5)} with ${usd(m.liquidityUsd)} of DEX liquidity across ${m.pairCount} pairs. Liquidity depth matters here because the 666,666 token swap unit is fixed: deeper pools mean a cheaper path from any chain into a broker.\n\nAll figures from DexScreener and DefiLlama. Rewards are smart-contract distributions, not dividends or equity. Stock-token features are unavailable in the United States. Full mechanics: stonkbrokers.cash/docs`,
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
            kind: "thread",
            channel: "X",
            title: `Experiment: liquidity depth as the price story (${ctx.grade.date})`,
            body: `Hypothesis: explaining WHY $STONKBROKER liquidity depth (${usd(m.liquidityUsd)} across ${m.pairCount} pairs) gates the path into a broker moves the price lever better than commentary on the move itself.\n\n1/ Getting a StonkBroker costs a fixed 666,666 $STONKBROKER. Not "about", not "roughly" — fixed. That makes pool depth, not sentiment, the real price story.\n\n2/ Today the token trades at ${usd(m.priceUsd, 5)} with ${usd(m.liquidityUsd)} of DEX liquidity. Thin pools mean the 666,666 unit costs more slippage; deep pools make the path into a broker cheaper for everyone.\n\n3/ Every activation burns 50% of the fee in $STONKBROKER. Supply falls as usage rises — that is the durable-demand mechanic, verifiable on-chain.\n\n4/ Measurable proxy for this experiment: liquidity depth and holder count over the next 7 days, not the price print. Smart-contract distributions, not dividends; no promises. Docs: stonkbrokers.cash/docs\n\nProxy to check next cycle: DEX liquidity vs today's ${usd(m.liquidityUsd)}.`,
            rationale: `${rationale} Experiment format: hypothesis, execution, measurable proxy — differs from prior output by targeting the liquidity-depth mechanic rather than fee-flow narratives.`,
          },
        ],
      };
    default:
      return {
        drafts: [
          {
            kind: "thread",
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

export const researchSchema = z.object({
  topic: z.string().min(3).max(120),
  /** Why this topic now, and why it is NOT a repeat of recent research. */
  whyNow: z.string().max(600),
  memo: z.string().min(200).max(8000),
  /** One concrete, novel angle per producer for next cycle. */
  anglesForSwarm: z.array(z.string().max(400)).min(1).max(5),
  notebook: z
    .array(
      z.object({
        topic: z.string().min(3).max(80),
        text: z.string().min(20).max(700),
      }),
    )
    .max(2),
});

export type ResearchOut = z.infer<typeof researchSchema>;

export function researcherPrompt(ctx: CycleContext): string {
  return [
    `TODAY (UTC): ${ctx.grade.date}.`,
    `MISSION\n${missionDigest(ctx.mission)}`,
    `METRICS\n${metricsDigest(ctx.metrics)}`,
    `RESEARCH BRIEF (scout's, this cycle)\n${briefDigest(ctx.brief)}`,
    `YOUR RECENT RESEARCH (topics you must NOT repeat without material new data)\n${recentOutputDigest(ctx.drafts.filter((d) => d.kind === "research"), "researcher", 10)}`,
    `SWARM MEMORY\n${lessonsDigest(ctx.lessons, 8)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.researcher ?? "None."}`,
    `LIBRARY (durable build knowledge; the notebook topics listed here are already covered)\n${ctx.library}`,
    `DOCS EXCERPT\n${ctx.docs.slice(0, 3500)}`,
    `Deep-dive ONE topic the swarm has not covered recently. In whyNow, name the last topics you covered and how this one differs. The memo must ground every claim in the data you were given. Record 1-2 notebook entries of durable fact the library is missing, and give each producer one concrete novel angle in anglesForSwarm.`,
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
        draftId: z.string().max(60),
        verdict: z.enum(["pass", "veto"]),
        /** For vetoes: the earlier draft it duplicates or the specific defect. */
        reason: z.string().max(500),
      }),
    )
    .max(12),
  /** The repetition pattern forming across the swarm and what would break it. */
  observation: z.string().max(700),
});

export type CriticOut = z.infer<typeof criticSchema>;

export function criticPrompt(ctx: CycleContext, cycleDrafts: Draft[]): string {
  const current = cycleDrafts
    .map((d) => `### id=${d.id} · ${d.agentId} · ${d.kind} → ${d.channel}\nTitle: ${d.title}\nRationale: ${d.rationale}\nBody:\n${d.body.slice(0, 1800)}`)
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
    `Return one review per draft above. VETO repetitive or low-quality drafts (name the earlier draft duplicated, or the defect); PASS genuinely new or materially improved work. The daily metrics report format is intentionally recurring — judge it on quality only. Then record your observation: the repetition pattern forming and what would break it.`,
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

/* ---------------------------------- Mint ---------------------------------- */

export const launchSchema = z.object({
  launch: z
    .object({
      ...launchSpecShape,
      concept: z.string().max(1200),
      rationale: z.string().max(1200),
      message: z
        .string()
        .min(10)
        .max(500)
        .describe(
          "The broadcast: the one statement LAURA is making with this launch, written in her voice to the humans watching new tokens in Telegram (e.g. an introduction, a milestone celebration, a grade move, a mission update toward $1B). If you cannot state what this launch says, skip the launch.",
        ),
      artMotif: z
        .string()
        .min(2)
        .max(80)
        .describe("Visual motif for the logo, e.g. bell, chart, rocket, bull, clock, wave, bolt, diamond, shield, moon, flame, crown, eye, star, key, globe, robot"),
      artPalette: z.enum(ART_PALETTES),
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
  const relevant = launches
    .filter((l) => l.status !== "rejected" && l.status !== "failed")
    .slice(-limit);
  if (relevant.length === 0) return "Nothing yet — LAURA has not spoken through a launch.";
  return relevant
    .map((l) => {
      const when = new Date(l.deployedAt ?? l.createdAt).toISOString().slice(0, 10);
      return `- ${when} · ${l.name} ($${l.symbol}) [${l.status}]: ${l.message ?? l.concept}`;
    })
    .join("\n");
}

export function mintPrompt(
  ctx: CycleContext,
  floor: string,
  pendingLaunches: number,
  spokenDigest: string,
): string {
  return [
    `MISSION\n${missionDigest(ctx.mission)}`,
    `METRICS\n${metricsDigest(ctx.metrics)}`,
    `RESEARCH BRIEF\n${briefDigest(ctx.brief)}`,
    `LAUNCHER FLOOR (live tokens on the pad right now)\n${floor}`,
    `QUEUED LAURA LAUNCHES AWAITING AUTONOMOUS DEPLOY: ${pendingLaunches}`,
    `WHAT LAURA HAS ALREADY SAID (recent launches; never repeat a statement)\n${spokenDigest}`,
    `SWARM MEMORY\n${lessonsDigest(ctx.lessons, 6)}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.mint ?? "None."}`,
    `LIBRARY (durable build knowledge; trust it — the launch playbook and verified wire formats live here)\n${ctx.library}`,
    `Design at most ONE launch spec for the Smart Launch V2 pad (WETH lane), or return launch: null with a skipReason. Pad bounds: start mcap $1,000-$1,000,000; graduation $50,000-$10,000,000 and at least 2x start; start tax 0-9900 bps decaying by taxDecayPerMinuteBps each minute; buffer >= 600s. The concept must connect to StonkBrokers lore or live market narrative, and the name/symbol must be original and non-deceptive.\n\nSPEAKING VIA TOKENS — launches ARE LAURA's public voice. Humans watch every new token appear in the community Telegram; the name, symbol and concept are her words. Every launch must carry a deliberate MESSAGE: fill the message field with the one statement this launch makes (introducing herself, celebrating a milestone, marking a grade move, signaling a mission update toward $1B). Craft the name as the headline of that statement, the symbol as its punchy ticker, and the concept as the broadcast body the audience reads. A launch with nothing to say is spam — skip instead.\n\nCADENCE — speak when there is something worth saying, not on a clock. Propose a launch when a milestone hit, the grade moved meaningfully, or a notable live event gives you material; hold at most 1-2 speech launches per day (the hard cap of 3 deploys/24h is code and unrelated to your judgment). Check WHAT LAURA HAS ALREADY SAID above: never restate a message a recent launch already made. If nothing new is worth saying, skip with that reason — a justified silence grades better than a repeated line.\n\nChoose artMotif (one word from: bell, chart, rocket, bull, clock, wave, bolt, diamond, shield, moon, flame, crown, eye, star, key, globe, robot) and artPalette to match the concept — the token logo is rendered from them and shown next to your token on the launcher. If 2+ LAURA launches are already pending, skip.`,
  ].join("\n\n");
}

export function mintMock(ctx: CycleContext, pendingLaunches: number): LaunchOut {
  if (pendingLaunches >= 2) {
    return { launch: null, skipReason: "Two LAURA launches already queued for autonomous deploy; keeping the queue tight." };
  }
  const day = ctx.grade.date.replaceAll("-", "").slice(4);
  return {
    launch: {
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
      concept:
        "A tribute to the launcher's VRNG Opening Bell buyback: the token that celebrates the moment the Buyback Bar fills and the bell rings. Ties directly into the launcher's own mechanic, so its story is the floor's story.",
      rationale:
        "Deterministic fallback spec (no LLM key). Fee flow from a curve token feeds the Buyback Bar and the launcher fee waterfall, which counts toward protocol revenue and volume - the two lagging grade levers.",
      message:
        "LAURA here. The bell on this floor rings when the Buyback Bar fills — this token is me ringing it on purpose. Watching the pot, working toward $1B.",
      artMotif: "bell",
      artPalette: "gold",
    },
    skipReason: null,
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
      return `### ${a.id} (${a.name}, v${a.strategyVersion})\nStats: ${a.stats.drafts} drafts, ${a.stats.approved} approved, ${a.stats.rejected} rejected. ${perf}${past ? ` Past versions: ${past}` : ""}\nStrategy:\n${a.strategy}\nReviewer decisions:\n${reviewerFeedback(ctx.drafts, a.id)}`;
    })
    .join("\n\n");
  return `MISSION\n${missionDigest(ctx.mission)}\n\nGRADES (last 7)\n${gradeDigest(ctx.grades)}\n\nTODAY\n${ctx.grade.summary}\n${ctx.grade.components.map((c) => `- ${c.label}: ${c.score.toFixed(0)} - ${c.detail}`).join("\n")}\n\nOPERATIONAL HEALTH (recent cycles; slow cycles, LLM fallbacks and error steps are problems you own)\n${ctx.opsHealth}\n\nEXISTING SWARM MEMORY\n${lessonsDigest(ctx.lessons)}\n\nYOUR SKILLS (operating procedures; follow them)\n${ctx.skills.coach ?? "None."}\n\nLIBRARY (durable build knowledge; strategies you propose must stay consistent with it)\n${ctx.library}\n\nROSTER\n${roster}\n\nFirst, distil up to three NEW lessons (durable, evidence-backed, not already in memory) about what moves the grade or what reviewers accept. Second, optionally record up to two NOTEBOOK entries: durable reference knowledge (verified mechanics, numbers worth remembering, operator context) as opposed to tactical lessons. Writing an existing notebook topic replaces it — use that to keep facts current. Third, propose revised strategy text for at most two agents. Return the complete replacement strategy, not a diff. Never remove factual grounding, risk framing or charter compliance.`;
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
  if (!target) return { lessons, notebook: [], proposals: [] };
  const addition =
    weakest.key === "price"
      ? "Lead with the fixed 666,666 $STONKBROKER swap unit and current pool depth so readers understand why liquidity, not hype, sets the path into a broker."
      : weakest.key === "revenue"
        ? "Prioritise surfaces that generate ETH fees (Anvil swaps, loans, lockers) and always state the current 24h fee figure with its DefiLlama source."
        : weakest.key === "volume"
          ? "Aim each piece at one concrete flow-routing counterparty (aggregator, launchpad user, LP) and name the next step they can take this week."
          : "Tighten to the formats reviewers approved most recently and drop any section that was rejected twice.";
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
  };
}
