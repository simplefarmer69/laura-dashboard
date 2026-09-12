import { ageOfMs, compactUsd, radarPct } from "@/lib/swarm/intel";
import type { IntelSnapshot, IntelTweet, LaunchRadarToken, StockTapeEntry } from "@/lib/types";

/**
 * CHAIN ALPHA: the things on Robinhood Chain most people have not noticed,
 * computed in code from this cycle's live reads and the snapshot from about a
 * day earlier. Operator directive 2026-09-12: "people want alpha about
 * robinhood chain that they may not have noticed". A model reading the raw
 * radar sees a table; this turns the table into deltas, ratios and
 * off-hours anomalies, each with its number and its source, ranked so the
 * first line is the sharpest. Pure function over stored snapshots: no I/O,
 * no side effects, and it never touches an execution path.
 */

interface AlphaLine {
  /** Higher sorts first. */
  weight: number;
  text: string;
}

const DAY_MS = 24 * 3_600_000;
const MAX_LINES = 8;
const MAX_CHARS = 1600;
/** A busy launch day produces eight NEW PAIR lines; the cap keeps the tape,
    counters and leadership lines in the block (observed 2026-09-12: seven new
    pairs pushed AMC's $6.2M Saturday tape and a +99% 7d TVL move out). */
const MAX_PER_CATEGORY = 3;

function capped(lines: AlphaLine[], max = MAX_PER_CATEGORY): AlphaLine[] {
  return [...lines].sort((a, b) => b.weight - a.weight).slice(0, max);
}

/** NYSE regular session in UTC (13:30–20:00 Mon–Fri; DST shifts ignored on purpose, the hour band is a heuristic). */
export function usStockMarketOpen(now = Date.now()): boolean {
  const d = new Date(now);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes >= 13 * 60 + 30 && minutes < 20 * 60;
}

function ratio(now: number, before: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
  return now / before;
}

function pctDelta(now: number, before: number): string {
  const r = ratio(now, before);
  if (r === null) return "n/a";
  const pct = (r - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** The snapshot closest to 24h before `current`, or the previous one when history is short. */
function priorSnapshot(current: IntelSnapshot, history: IntelSnapshot[]): IntelSnapshot | null {
  const older = history.filter((s) => s.ts < current.ts);
  if (older.length === 0) return null;
  const target = current.ts - DAY_MS;
  return older.reduce((best, s) => (Math.abs(s.ts - target) < Math.abs(best.ts - target) ? s : best), older[0]);
}

function hoursBetween(a: number, b: number): string {
  const h = Math.abs(a - b) / 3_600_000;
  return h < 1.5 ? `${Math.max(1, Math.round(h * 60))}m` : `${Math.round(h)}h`;
}

function radarLines(current: IntelSnapshot, prior: IntelSnapshot | null, now: number): AlphaLine[] {
  const radar = current.launchRadar;
  if (!radar) return [];
  const out: AlphaLine[] = [];
  const priorByAddr = new Map<string, LaunchRadarToken>(
    (prior?.launchRadar?.tokens ?? []).map((t) => [t.address.toLowerCase(), t]),
  );
  const span = prior?.launchRadar ? hoursBetween(current.ts, prior.ts) : null;

  for (const t of radar.tokens) {
    const age = t.pairCreatedAt ? now - t.pairCreatedAt : null;
    if (age !== null && age < DAY_MS && t.volume24hUsd >= 500) {
      const volToLiq = t.liquidityUsd && t.liquidityUsd > 0 ? t.volume24hUsd / t.liquidityUsd : null;
      const churn = volToLiq !== null && volToLiq >= 10 ? `; volume is ${volToLiq.toFixed(0)}x the liquidity left in the pool` : "";
      out.push({
        weight: 90 + Math.min(9, Math.log10(Math.max(1, t.volume24hUsd))),
        text: `NEW PAIR: ${t.symbol} "${t.name}" on ${t.dexId}, pair ${ageOfMs(t.pairCreatedAt)}; ${compactUsd(t.volume24hUsd)} traded so far, liq ${compactUsd(t.liquidityUsd)}, mcap ${compactUsd(t.marketCapUsd)}${t.boosted ? ", paying for a DexScreener boost" : ""}${churn} (DexScreener).`,
      });
      continue;
    }
    const before = priorByAddr.get(t.address.toLowerCase());
    const r = before ? ratio(t.volume24hUsd, before.volume24hUsd) : null;
    if (r !== null && span && (r >= 2 || r <= 0.5) && Math.max(t.volume24hUsd, before?.volume24hUsd ?? 0) >= 2_000) {
      out.push({
        weight: 70 + Math.min(15, Math.abs(Math.log2(r)) * 5),
        text: `VOLUME ${r >= 2 ? "SPIKE" : "DRAIN"}: ${t.symbol} 24h volume ${compactUsd(t.volume24hUsd)} vs ${compactUsd(before?.volume24hUsd ?? 0)} in the snapshot ${span} earlier (${pctDelta(t.volume24hUsd, before?.volume24hUsd ?? 0)}), price ${radarPct(t.priceChange24hPct)} 24h, liq ${compactUsd(t.liquidityUsd)} (DexScreener).`,
      });
      continue;
    }
    if (t.priceChange24hPct !== null && Math.abs(t.priceChange24hPct) >= 30 && t.volume24hUsd >= 2_000) {
      out.push({
        weight: 60 + Math.min(15, Math.abs(t.priceChange24hPct) / 10),
        text: `MOVER: ${t.symbol} ${radarPct(t.priceChange24hPct)} in 24h on ${compactUsd(t.volume24hUsd)} volume against ${compactUsd(t.liquidityUsd)} of liquidity, mcap ${compactUsd(t.marketCapUsd)} (DexScreener). Thin liquidity relative to volume means the move can reverse as fast.`,
      });
    }
  }

  const m = radar.mission;
  const pm = prior?.launchRadar?.mission ?? null;
  if (m && pm && span) {
    const r = ratio(m.volume24hUsd, pm.volume24hUsd);
    if (r !== null && (r >= 1.6 || r <= 0.6) && Math.max(m.volume24hUsd, pm.volume24hUsd) >= 1_000) {
      out.push({
        weight: 55,
        text: `$STONKBROKER own pair: 24h volume ${compactUsd(m.volume24hUsd)} vs ${compactUsd(pm.volume24hUsd)} ${span} earlier (${pctDelta(m.volume24hUsd, pm.volume24hUsd)}), price ${radarPct(m.priceChange24hPct)} 24h, liq ${compactUsd(m.liquidityUsd)} (DexScreener).`,
      });
    }
  }
  return out;
}

function stockTapeLines(current: IntelSnapshot, prior: IntelSnapshot | null, now: number): AlphaLine[] {
  const tape = current.memeMarket?.stockTape ?? [];
  if (tape.length === 0) return [];
  const out: AlphaLine[] = [];
  const total = tape.reduce((s, e) => s + e.volume24hUsd, 0);
  const top = tape[0];
  const marketOpen = usStockMarketOpen(now);
  if (!marketOpen && total >= 5_000) {
    const share = total > 0 ? (top.volume24hUsd / total) * 100 : 0;
    const d = new Date(now);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    out.push({
      weight: 85,
      text: `AFTER HOURS: the stock market is ${weekend ? "closed for the weekend" : "shut right now"} and the tokenized stocks on Robinhood Chain still printed ${compactUsd(total)} of 24h volume across ${tape.length} tickers; ${top.symbol} alone ${compactUsd(top.volume24hUsd)} across ${top.pools} pool${top.pools === 1 ? "" : "s"} (${share.toFixed(0)}% of the tape), ${radarPct(top.priceChange24hPct)} 24h (DexScreener).`,
    });
  }
  const priorBySym = new Map<string, StockTapeEntry>((prior?.memeMarket?.stockTape ?? []).map((e) => [e.symbol, e]));
  const span = prior?.memeMarket ? hoursBetween(current.ts, prior.ts) : null;
  for (const e of tape.slice(0, 5)) {
    const before = priorBySym.get(e.symbol);
    const r = before ? ratio(e.volume24hUsd, before.volume24hUsd) : null;
    if (r !== null && span && (r >= 2 || r <= 0.5) && Math.max(e.volume24hUsd, before?.volume24hUsd ?? 0) >= 5_000) {
      out.push({
        weight: 65 + Math.min(10, Math.abs(Math.log2(r)) * 4),
        text: `STOCK TOKEN ${r >= 2 ? "ROTATION IN" : "ROTATION OUT"}: ${e.symbol} tokenized-stock volume ${compactUsd(e.volume24hUsd)} vs ${compactUsd(before?.volume24hUsd ?? 0)} ${span} earlier (${pctDelta(e.volume24hUsd, before?.volume24hUsd ?? 0)}), ${e.pools} pools (DexScreener).`,
      });
    }
  }
  if (!marketOpen && tape.length >= 2 && total > 0) {
    const second = tape[1];
    const gap = second.volume24hUsd > 0 ? top.volume24hUsd / second.volume24hUsd : null;
    if (gap !== null && gap >= 3) {
      out.push({
        weight: 50,
        text: `CONCENTRATION: ${top.symbol} is pulling ${gap.toFixed(1)}x the volume of the second stock token (${second.symbol}, ${compactUsd(second.volume24hUsd)}); retail on the chain is trading one name (DexScreener).`,
      });
    }
  }
  return out;
}

function brokerToolsLines(current: IntelSnapshot, prior: IntelSnapshot | null): AlphaLine[] {
  const bt = current.brokerTools;
  if (!bt) return [];
  const out: AlphaLine[] = [];
  const flow = bt.buyUsd + bt.sellUsd;
  if (bt.tapeTrades >= 20 && flow >= 2_000) {
    const buyShare = (bt.buyUsd / flow) * 100;
    if (buyShare >= 65 || buyShare <= 35) {
      out.push({
        weight: 62,
        text: `TAPE IMBALANCE: the last ${bt.tapeTrades} chain-wide DEX trades${bt.tapeSpanMin !== null ? ` (~${bt.tapeSpanMin} minutes)` : ""} were ${buyShare.toFixed(0)}% buys by USD, ${compactUsd(bt.buyUsd)} bought vs ${compactUsd(bt.sellUsd)} sold; most traded ${bt.topSymbols.slice(0, 3).map((s) => `${s.symbol} ${compactUsd(s.usd)}`).join(", ")} (brokertools.info).`,
      });
    }
  }
  const pbt = prior?.brokerTools ?? null;
  if (bt.launchesTotal !== null && pbt?.launchesTotal !== null && pbt?.launchesTotal !== undefined) {
    const added = bt.launchesTotal - pbt.launchesTotal;
    if (added > 0) {
      out.push({
        weight: 58 + Math.min(10, added),
        text: `LAUNCH COUNT: ${added} new Stonklauncher launch${added === 1 ? "" : "es"} indexed since the snapshot ${hoursBetween(current.ts, prior!.ts)} earlier (${pbt.launchesTotal} to ${bt.launchesTotal}); top by mcap ${bt.topLaunches.slice(0, 2).map((l) => `${l.symbol} ${compactUsd(l.mcapUsd)}${l.phase ? ` ${l.phase}` : ""}`).join(", ")} (brokertools.info).`,
      });
    }
  }
  return out;
}

function chainStatLines(current: IntelSnapshot, prior: IntelSnapshot | null): AlphaLine[] {
  const out: AlphaLine[] = [];
  if (current.holderCount !== null && prior?.holderCount !== null && prior?.holderCount !== undefined) {
    const d = current.holderCount - prior.holderCount;
    if (Math.abs(d) >= 5) {
      out.push({
        weight: 48 + Math.min(12, Math.abs(d) / 5),
        text: `HOLDERS: $STONKBROKER wallets ${d >= 0 ? "+" : ""}${d} in ${hoursBetween(current.ts, prior.ts)} (${prior.holderCount.toLocaleString()} to ${current.holderCount.toLocaleString()}, Blockscout).`,
      });
    }
  }
  const tvl = current.tvl;
  if (tvl?.protocolTvlUsd !== null && tvl?.protocolTvlUsd !== undefined && tvl.change24hPct !== null && Math.abs(tvl.change24hPct) >= 5) {
    out.push({
      weight: 52 + Math.min(10, Math.abs(tvl.change24hPct) / 2),
      text: `TVL: StonkBrokers protocol TVL ${compactUsd(tvl.protocolTvlUsd)}, ${radarPct(tvl.change24hPct)} in 24h${tvl.change7dPct !== null ? `, ${radarPct(tvl.change7dPct)} in 7d` : ""} (DefiLlama).`,
    });
  }
  if (current.x && prior?.x && prior.x.mentionCount24h >= 3) {
    const r = ratio(current.x.mentionCount24h, prior.x.mentionCount24h);
    if (r !== null && (r >= 2 || r <= 0.5)) {
      out.push({
        weight: 40,
        text: `ATTENTION: ${current.x.mentionCount24h} X posts mentioned $STONKBROKER in the last 24h vs ${prior.x.mentionCount24h} a day earlier (${pctDelta(current.x.mentionCount24h, prior.x.mentionCount24h)}), ${current.x.engagement24h} engagements (X search).`,
      });
    }
  }
  return out;
}

const CHAIN_TOPIC_RE = /robinhood\s*chain|stock\s*tokens?|tokeni[sz]ed\s+(?:stocks?|equit)|rh\s*chain|prediction\s+markets?|robinhood\s+(?:crypto|wallet|legend)/i;

/** Leadership or KOL posts about the chain that few people saw yet. */
function underNoticedLines(current: IntelSnapshot): AlphaLine[] {
  const x = current.x;
  if (!x) return [];
  const pool: IntelTweet[] = [
    ...x.leaders.flatMap((l) => l.tweets),
    ...(x.watch ?? []),
    ...(x.catalysts ?? []),
  ];
  const seen = new Set<string>();
  const out: AlphaLine[] = [];
  for (const t of pool) {
    if (seen.has(t.id) || !CHAIN_TOPIC_RE.test(t.text)) continue;
    seen.add(t.id);
    const ageH = t.createdAt ? (Date.now() - new Date(t.createdAt).getTime()) / 3_600_000 : null;
    if (ageH !== null && ageH > 36) continue;
    if (t.likes > 400) continue;
    out.push({
      weight: 45 + (t.likes < 50 ? 8 : 0),
      text: `UNDER-NOTICED: @${t.author.replace(/\s*\(.*\)$/, "")} posted about the chain ${ageH !== null ? `${Math.max(1, Math.round(ageH))}h ago` : "recently"} and it has ${t.likes} likes so far: "${t.text.replace(/\s+/g, " ").slice(0, 150)}" (X).`,
    });
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * The digest injected into prompts. Empty-safe: when the radar and tape are
 * both missing the block says so, so a producer never fills the gap with an
 * invented number.
 */
export function chainAlphaDigest(current: IntelSnapshot | null, history: IntelSnapshot[], now = Date.now()): string {
  const header =
    "CHAIN ALPHA (computed this cycle from live reads: what changed on Robinhood Chain that most people have not noticed. Every line carries its number and source; the first line is the sharpest. A post that leads with one of these is what this account's readers follow it for):";
  if (!current) return `${header}\n- unavailable this cycle (no live intel snapshot); do not invent one.`;
  const prior = priorSnapshot(current, history);
  const lines = [
    ...capped(radarLines(current, prior, now)),
    ...capped(stockTapeLines(current, prior, now)),
    ...capped(brokerToolsLines(current, prior), 2),
    ...capped(chainStatLines(current, prior)),
    ...capped(underNoticedLines(current), 2),
  ].sort((a, b) => b.weight - a.weight);
  if (lines.length === 0) {
    return `${header}\n- nothing anomalous computed this cycle (radar, tape and counters moved within normal bands${prior ? "" : "; no prior snapshot to diff against yet"}). Post about LAURA's own wallet or the Cafe Bar instead; do not invent a chain event.`;
  }
  const out: string[] = [header];
  let chars = header.length;
  for (const l of lines.slice(0, MAX_LINES)) {
    const text = `- ${l.text}`;
    if (chars + text.length > MAX_CHARS) break;
    out.push(text);
    chars += text.length + 1;
  }
  const span = prior ? `Diffed against the snapshot from ${hoursBetween(current.ts, prior.ts)} earlier.` : "First snapshot; deltas start next cycle.";
  out.push(`(${span} Windows are DexScreener 24h figures unless stated.)`);
  return out.join("\n");
}
