/**
 * World context for token ideation: prediction markets, live sports, the
 * Stonklauncher buy tape, protocol economics and broker NFT sales, distilled
 * into one compact text block that the scout / producer / mint prompts
 * receive as ctx.world.
 *
 * Sources:
 * - Polymarket gamma-api (public, unkeyed) - fetched direct, mirroring the
 *   dashboard's /api/feeds/polymarket query exactly.
 * - ESPN site.api.espn.com scoreboards (public, unkeyed) - fetched direct,
 *   mirroring /api/feeds/espn.
 * - Launcher tape / DeFiLlama / broker NFT sales - read from the dashboard's
 *   own feed endpoints (LAURA_FEEDS_BASE, default laura.stonkbrokers.io),
 *   which carry the heavy caching and chain-scan cursors server-side.
 *
 * Everything here is read-only and unkeyed; anything keyed (the X API) stays
 * in intel.ts driven by VM env. Every source fails soft: a dark upstream
 * drops its section from the digest, never the cycle.
 */

import { cached, getJson } from "@/lib/feeds/util";
import { chatterDigest } from "@/lib/chat/chatter";

function feedsBase(): string {
  return (process.env.LAURA_FEEDS_BASE || "https://laura.stonkbrokers.io").replace(/\/$/, "");
}

/* ------------------------------ polymarket ------------------------------ */

type GammaMarket = {
  question?: string;
  outcomes?: string; // JSON-encoded string array
  outcomePrices?: string; // JSON-encoded string array
  volume24hr?: number;
  endDate?: string;
};

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

async function polymarketLines(): Promise<string[]> {
  const url =
    "https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=10";
  const { data } = await cached("swarm:polymarket", 5 * 60_000, () =>
    getJson<GammaMarket[]>(url, 12_000),
  );
  return data
    .filter((m) => m.question)
    .slice(0, 6)
    .map((m) => {
      const outcomes = parseJsonArray(m.outcomes);
      const prices = parseJsonArray(m.outcomePrices);
      const odds = outcomes
        .slice(0, 2)
        .map((o, i) => {
          const p = Number(prices[i]);
          return Number.isFinite(p) ? `${o} ${(p * 100).toFixed(0)}%` : o;
        })
        .join(" / ");
      const vol = Number(m.volume24hr);
      const volTxt = Number.isFinite(vol) && vol > 0 ? ` ($${Math.round(vol).toLocaleString()} 24h)` : "";
      return `- ${m.question}${odds ? `: ${odds}` : ""}${volTxt}`;
    });
}

/* --------------------------------- espn --------------------------------- */

const ESPN_LEAGUES = [
  { league: "NFL", path: "football/nfl" },
  { league: "MLB", path: "baseball/mlb" },
  { league: "NBA", path: "basketball/nba" },
] as const;

type EspnScoreboard = {
  events?: Array<{
    shortName?: string;
    status?: { type?: { state?: string; shortDetail?: string } };
    competitions?: Array<{
      competitors?: Array<{
        homeAway?: string;
        score?: string;
        team?: { abbreviation?: string };
      }>;
    }>;
  }>;
};

async function espnLines(): Promise<string[]> {
  const { data } = await cached("swarm:espn", 5 * 60_000, async () => {
    const settled = await Promise.allSettled(
      ESPN_LEAGUES.map(async ({ league, path }) => {
        const sb = await getJson<EspnScoreboard>(
          `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`,
          12_000,
        );
        return (sb.events ?? []).map((ev) => {
          const comp = ev.competitions?.[0]?.competitors ?? [];
          const home = comp.find((c) => c.homeAway === "home");
          const away = comp.find((c) => c.homeAway === "away");
          const score =
            home?.score != null && away?.score != null
              ? ` ${away.team?.abbreviation ?? "?"} ${away.score} - ${home.team?.abbreviation ?? "?"} ${home.score}`
              : "";
          const state = ev.status?.type?.state ?? "pre";
          const detail = ev.status?.type?.shortDetail ?? "";
          return { league, state, line: `- ${league} ${ev.shortName ?? "game"}${score} (${detail})` };
        });
      }),
    );
    return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  });
  /* Live games first, then upcoming; finals last. Cap the block. */
  const rank = (s: string) => (s === "in" ? 0 : s === "pre" ? 1 : 2);
  return data
    .slice()
    .sort((a, b) => rank(a.state) - rank(b.state))
    .slice(0, 8)
    .map((g) => g.line);
}

/* ------------------------- dashboard feed reads -------------------------- */

type LauncherFeed = {
  ok?: boolean;
  ethUsd?: number | null;
  buys?: Array<{ launchId?: number; eth?: number; paidIn?: string; mcapUsd?: number | null; ts?: number }>;
  stats?: {
    launches?: number;
    graduated?: number;
    bonded?: number;
    buys?: number;
    uniqueBuyers?: number;
    grossBuyEth?: number;
  } | null;
};

async function launcherLines(): Promise<string[]> {
  const { data } = await cached("swarm:feed:launcher", 2 * 60_000, () =>
    getJson<LauncherFeed>(`${feedsBase()}/api/feeds/launcher`, 12_000),
  );
  const lines: string[] = [];
  const s = data.stats;
  if (s) {
    lines.push(
      `- Pad stats: ${s.launches ?? "?"} launches, ${s.graduated ?? "?"} graduated, ${s.bonded ?? "?"} bonded, ${s.uniqueBuyers ?? "?"} unique buyers, ${s.grossBuyEth?.toFixed?.(2) ?? "?"} ETH gross buys`,
    );
  }
  const buys = (data.buys ?? []).slice(0, 4);
  for (const b of buys) {
    const eth = Number(b.eth);
    if (!Number.isFinite(eth)) continue;
    const mcap = Number(b.mcapUsd);
    lines.push(
      `- Buy ${eth.toFixed(3)} ETH paid in ${b.paidIn ?? "?"} on launch #${b.launchId ?? "?"}${Number.isFinite(mcap) && mcap > 0 ? ` (mcap $${Math.round(mcap).toLocaleString()})` : ""}`,
    );
  }
  return lines;
}

type LlamaFeed = {
  tvl?: { currentUsd?: number | null };
  fees?: { total24hUsd?: number | null };
  revenue?: { total24hUsd?: number | null };
  dexVolume?: { total24hUsd?: number | null };
};

async function llamaLine(): Promise<string[]> {
  const { data } = await cached("swarm:feed:defillama", 10 * 60_000, () =>
    getJson<LlamaFeed>(`${feedsBase()}/api/feeds/defillama`, 12_000),
  );
  const usd = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? null : `$${Math.round(v).toLocaleString()}`;
  const parts = [
    usd(data.tvl?.currentUsd) ? `TVL ${usd(data.tvl?.currentUsd)}` : null,
    usd(data.fees?.total24hUsd) ? `fees 24h ${usd(data.fees?.total24hUsd)}` : null,
    usd(data.revenue?.total24hUsd) ? `revenue 24h ${usd(data.revenue?.total24hUsd)}` : null,
    usd(data.dexVolume?.total24hUsd) ? `DEX vol 24h ${usd(data.dexVolume?.total24hUsd)}` : null,
  ].filter(Boolean);
  return parts.length ? [`- StonkBrokers protocol (DeFiLlama): ${parts.join(", ")}`] : [];
}

type NftFeed = {
  sales?: Array<{ priceEth?: number; ts?: number }>;
};

/**
 * The cycle runs inside the same server that serves /api/feeds/nft-buys, and
 * that local instance holds the warmed Seaport scan window. The public deploy
 * recycles serverless instances before their backward seed reaches the newest
 * sale, so it can serve an empty tape while real sales exist on-chain. Local
 * first (port 4747 is pinned in package.json dev/start), configured base as
 * the fallback for anything running without the local server.
 */
async function nftFeed(): Promise<NftFeed> {
  try {
    const local = await getJson<NftFeed>("http://127.0.0.1:4747/api/feeds/nft-buys", 25_000);
    if ((local.sales ?? []).length > 0) return local;
  } catch {
    /* local server unavailable: fall through to the configured base */
  }
  return getJson<NftFeed>(`${feedsBase()}/api/feeds/nft-buys`, 12_000);
}

async function nftLine(): Promise<string[]> {
  const { data } = await cached("swarm:feed:nft", 5 * 60_000, nftFeed);
  const sales = (data.sales ?? []).filter((s) => Number.isFinite(Number(s.priceEth)));
  const dayAgo = Date.now() - 24 * 3600_000;
  const recent = sales.filter((s) => (s.ts ?? 0) > dayAgo);
  if (recent.length > 0) {
    const top = Math.max(...recent.map((s) => Number(s.priceEth)));
    return [`- StonkBroker NFT sales last 24h: ${recent.length} (top ${top.toFixed(3)} ETH)`];
  }
  /* A quiet market reads better as an explicit fact than a vanished section:
   * the scan is healthy, there are just no fills inside the window. */
  const newest = sales.length ? Math.max(...sales.map((s) => s.ts ?? 0)) : 0;
  return [
    newest > 0
      ? `- StonkBroker NFT sales last 24h: none (newest sale on the tape is ~${Math.round((Date.now() - newest) / 3600_000)}h old)`
      : "- StonkBroker NFT sales last 24h: none on the scanned window",
  ];
}

/* -------------------------------- digest --------------------------------- */

async function section(title: string, load: () => Promise<string[]>): Promise<string> {
  try {
    const lines = await load();
    return lines.length ? `${title}\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

/**
 * One text block for prompt injection: world feeds plus recent community
 * chatter. Each source is independent and fail-soft; a fully dark world
 * returns a short "unavailable" marker instead of an empty string so the
 * prompts always have something labeled to reference.
 */
export async function worldContext(): Promise<string> {
  const [poly, espn, launcher, llama, nft] = await Promise.all([
    section("PREDICTION MARKETS (Polymarket, by 24h volume)", polymarketLines),
    section("LIVE SPORTS (ESPN scoreboards)", espnLines),
    section("STONKLAUNCHER TAPE (live pad activity)", launcherLines),
    section("PROTOCOL ECONOMICS", llamaLine),
    section("NFT MARKET", nftLine),
  ]);
  const chatter = chatterDigest();
  const blocks = [poly, espn, launcher, llama, nft, chatter].filter(Boolean);
  if (blocks.length === 0) return "World feeds unavailable this cycle.";
  return blocks.join("\n\n").slice(0, 2400);
}
