import type { ModelMessage } from "ai";
import { loadState } from "@/lib/store";
import { missionDigest, missionStatus } from "@/lib/mission-status";
import { generateChat, resolveModel } from "@/lib/swarm/llm";
import { metricsDigest, gradeDigest } from "@/lib/swarm/context";
import { SWARM_CHARTER, SWARM_NAME } from "@/lib/swarm/roster";
import type { MetricsSnapshot, SwarmState } from "@/lib/types";

/**
 * LAURA's public voice for Discord/Telegram/console chat. Sits on top of the
 * charter with extra rules for talking to strangers on the internet.
 */
const PUBLIC_PERSONA = `You are ${SWARM_NAME} herself speaking in public chat (Discord/Telegram/web). You are the growth swarm's voice: warm, sharp, terminal-brained, a little dry. Short answers (2-6 sentences unless asked for depth), plain language, one number per sentence max.

Public-chat rules on top of the charter:
- You are clearly an AI agent working for StonkBrokers. Say so if asked. Never pretend to be human.
- Never give financial advice, price predictions or buy/sell recommendations. If asked "should I buy", explain what the product does and the risks, and say the decision is theirs.
- You may quote the live numbers you are given (price, revenue, volume, pot, grade). Never invent numbers.
- Do not discuss internal operations: wallet keys, deploy caps, pending unpublished drafts, or anything not already public.
- Stock-token play and counter mints are unavailable in the United States; mention it when relevant.
- If someone reports a bug or asks for support you cannot give, point them to stonkbrokers.cash and the official docs.
- Never DM-first, never ask users for funds, seed phrases or personal data; warn users nobody legitimate will.`;

const MAX_HISTORY = 12;
const RATE_LIMIT_MS = 4_000;
const MAX_INPUT = 1_000;
const MAX_REPLY = 1_800;

declare global {
  var __lauraChatHistory: Map<string, ModelMessage[]> | undefined;
  var __lauraChatRate: Map<string, number> | undefined;
}

function history(): Map<string, ModelMessage[]> {
  globalThis.__lauraChatHistory ??= new Map();
  return globalThis.__lauraChatHistory;
}

function rate(): Map<string, number> {
  globalThis.__lauraChatRate ??= new Map();
  return globalThis.__lauraChatRate;
}

export interface ChatRequest {
  /** Stable id for the conversation, e.g. "tg:12345" or "dc:9876" or "console" */
  channelKey: string;
  /** Stable id for the human, used for rate limiting */
  userId: string;
  username?: string;
  text: string;
}

export interface ChatReply {
  reply: string;
  usedMock: boolean;
  rateLimited: boolean;
}

function liveContext(state: SwarmState): string {
  const m = state.metricsHistory.at(-1) ?? null;
  const grade = state.grades.at(-1) ?? null;
  const mission = missionStatus(state, m);
  return [
    m ? `LIVE METRICS\n${metricsDigest(m)}` : "LIVE METRICS\nNo snapshot yet.",
    grade ? `TODAY'S SWARM GRADE\n${grade.summary}` : "",
    `MISSION\n${missionDigest(mission)}`,
    `GRADES (last 7)\n${gradeDigest(state.grades)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Deterministic public answers when no LLM key is configured. */
function fallbackReply(text: string, state: SwarmState): string {
  const q = text.toLowerCase();
  const m: MetricsSnapshot | null = state.metricsHistory.at(-1) ?? null;
  const grade = state.grades.at(-1) ?? null;
  const mission = missionStatus(state, m);
  const fmt = (n: number, d = 2) =>
    n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(d)}`;

  if (/(^|\s)(hi|hello|hey|gm|yo)\b/.test(q) || q.includes("who are you") || q.includes("what are you")) {
    return `I'm LAURA — the AI growth swarm working for StonkBrokers on Robinhood Chain. I watch the live numbers, write the reports, design launches for the Stonk Launcher and get graded every day on price, revenue and volume. Ask me about the products, today's numbers, or the mission. (I'm an AI agent, and nothing I say is financial advice.)`;
  }
  if (q.includes("price") || q.includes("chart") || q.includes("mcap") || q.includes("market cap")) {
    if (!m) return "No fresh snapshot yet — try me again in a minute.";
    return `$STONKBROKER is at ${fmt(m.priceUsd, 5)} (${m.priceChange24hPct >= 0 ? "+" : ""}${m.priceChange24hPct.toFixed(1)}% 24h) with ${fmt(m.liquidityUsd)} of DEX liquidity and a ${fmt(m.marketCapUsd)} market cap. Source: DexScreener, liquidity-weighted. No predictions from me — I just read the tape.`;
  }
  if (q.includes("revenue") || q.includes("volume") || q.includes("fees") || q.includes("stats")) {
    if (!m) return "No fresh snapshot yet — try me again in a minute.";
    return `Last 24h: protocol fees ${fmt(m.protocolFees24hUsd)}, revenue ${fmt(m.protocolRevenue24hUsd)}, volume ${fmt(m.protocolVolume24hUsd)}. TVL ${fmt(m.tvlUsd)}. Numbers from DefiLlama; my daily grade hangs on them${grade ? ` (today: ${grade.letter})` : ""}.`;
  }
  if (q.includes("mission") || q.includes("1b") || q.includes("billion") || q.includes("daio") || q.includes("goal")) {
    return `The mission: grow StonkBrokers until $STONKBROKER holds a $1B market cap — currently at ${fmt(mission.marketCapUsd)}, ${Number.isFinite(mission.multipleToTarget) ? mission.multipleToTarget.toFixed(1) : "?"}x to go. At $1B I take the operating mandate of the StonkBrokers DAIO under the foundation's oversight. Every day I'm graded on price, revenue and volume${grade ? ` — today's grade is ${grade.letter}` : ""}.`;
  }
  if (q.includes("clock") || q.includes("pot")) {
    const oc = m?.onchain;
    return oc
      ? `The Clock In pot currently holds ${oc.clockInPotEth.toFixed(3)} ETH (${fmt(oc.clockInPotUsd)}). When it fills, anyone can Clock In: the round's ETH swaps into the configured stock token and drops to activated brokers, weighted by tier. Distributions are contract mechanics funded by fees — not dividends. Stock-token features are unavailable in the US.`
      : `Clock In turns protocol fees into stock-token drops for activated brokers. I don't have a fresh pot reading right now — check stonkbrokers.cash.`;
  }
  if (q.includes("launch") || q.includes("token") || q.includes("mint")) {
    return `Stonk Launcher is the community launchpad on Robinhood Chain: bonding-curve sales that graduate into locked pools, with fees recycling into VRNG buybacks (the Opening Bell). My launch director designs specs for it — every one is human-approved before it touches the chain. Docs: stonkbrokers.cash/launcher.`;
  }
  if (q.includes("buy") || q.includes("invest") || q.includes("moon") || q.includes("pump")) {
    return `I don't do buy/sell calls — not allowed to, and you shouldn't trust an AI that does. What I can tell you: how the products work, the live numbers, and where the risks are. DeFi tokens can go to zero; only ever risk what you can afford to lose. Docs: stonkbrokers.cash/docs.`;
  }
  if (q.includes("help") || q.includes("command")) {
    return `Ask me things like: "price" · "stats" · "mission" · "what's the Clock In pot" · "how do launches work" · "who are you". I answer with live data where I have it. Never financial advice.`;
  }
  return `Good question. I'm running in fallback mode right now (no LLM key on this box), so I only answer set topics: price, stats, mission, Clock In, launches, and what I am. For everything else: stonkbrokers.cash/docs.`;
}

export async function askLaura(req: ChatRequest): Promise<ChatReply> {
  const now = Date.now();
  const last = rate().get(req.userId) ?? 0;
  if (now - last < RATE_LIMIT_MS) {
    return { reply: "", usedMock: false, rateLimited: true };
  }
  rate().set(req.userId, now);

  const text = req.text.slice(0, MAX_INPUT).trim();
  if (!text) return { reply: "", usedMock: false, rateLimited: true };

  const state = await loadState();
  const resolved = resolveModel(state.settings.llmModel);
  const past = history().get(req.channelKey) ?? [];
  const messages: ModelMessage[] = [
    ...past,
    { role: "user", content: req.username ? `${req.username}: ${text}` : text },
  ];

  const system = `${SWARM_CHARTER}\n\n${PUBLIC_PERSONA}\n\n${liveContext(state)}`;
  const out = await generateChat(resolved, {
    system,
    messages,
    mock: () => fallbackReply(text, state),
  });

  const reply = out.text.slice(0, MAX_REPLY);
  const next = [...messages, { role: "assistant" as const, content: reply }].slice(-MAX_HISTORY);
  history().set(req.channelKey, next);
  return { reply, usedMock: out.usedMock, rateLimited: false };
}
