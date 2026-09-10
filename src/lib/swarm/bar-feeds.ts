import { cached, getJson } from "@/lib/feeds/util";

/**
 * Off-protocol bar material for The Cafe Bar: a compact digest of live public
 * feeds (Polymarket lines, tonight's scores) so agents have real internet to
 * riff on beyond the mission. Same discipline as intel.ts: short timeouts,
 * per-source caching, and graceful degradation: a dark feed shrinks the
 * digest, never fails the round.
 */

const WIRE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

/* ------------------------------- Polymarket ------------------------------- */

const POLYMARKET_URL =
  "https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=8";

type GammaMarket = {
  question?: string;
  outcomes?: string; // JSON string array
  outcomePrices?: string; // JSON string array
  volume24hr?: number;
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
  const markets = await getJson<GammaMarket[]>(POLYMARKET_URL, FETCH_TIMEOUT_MS);
  return markets
    .filter((m) => m.question)
    .slice(0, 4)
    .map((m) => {
      const outcomes = parseJsonArray(m.outcomes);
      const prices = parseJsonArray(m.outcomePrices).map((p) => Number(p));
      const odds = outcomes
        .slice(0, 2)
        .map((label, i) => `${label} ${Math.round((prices[i] ?? 0) * 100)}%`)
        .join(" / ");
      const vol = m.volume24hr ? ` ($${Math.round(m.volume24hr / 1_000)}k 24h vol)` : "";
      return `Polymarket: "${m.question}": ${odds}${vol}`;
    });
}

/* --------------------------------- ESPN ---------------------------------- */

const ESPN_LEAGUES: Array<{ key: string; path: string }> = [
  { key: "NFL", path: "football/nfl" },
  { key: "MLB", path: "baseball/mlb" },
  { key: "NBA", path: "basketball/nba" },
];

type EspnScoreboard = {
  events?: Array<{
    shortName?: string;
    status?: { type?: { state?: string; shortDetail?: string } };
    competitions?: Array<{
      competitors?: Array<{ homeAway?: string; score?: string; team?: { abbreviation?: string } }>;
    }>;
  }>;
};

async function espnLines(): Promise<string[]> {
  const boards = await Promise.allSettled(
    ESPN_LEAGUES.map(async (l) => ({
      league: l.key,
      board: await getJson<EspnScoreboard>(
        `https://site.api.espn.com/apis/site/v2/sports/${l.path}/scoreboard`,
        FETCH_TIMEOUT_MS,
      ),
    })),
  );
  const games: Array<{ line: string; state: string }> = [];
  for (const r of boards) {
    if (r.status !== "fulfilled") continue;
    for (const e of r.value.board.events ?? []) {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      const away = comp?.competitors?.find((c) => c.homeAway === "away");
      if (!home?.team?.abbreviation || !away?.team?.abbreviation) continue;
      const state = e.status?.type?.state ?? "pre";
      const score =
        state === "pre" ? "" : ` ${away.score ?? "0"}-${home.score ?? "0"}`;
      games.push({
        state,
        line: `${r.value.league} ${e.shortName ?? `${away.team.abbreviation} @ ${home.team.abbreviation}`}${score} (${e.status?.type?.shortDetail ?? state})`,
      });
    }
  }
  const rank = (s: string) => (s === "in" ? 0 : s === "post" ? 1 : 2);
  games.sort((a, b) => rank(a.state) - rank(b.state));
  const top = games.slice(0, 5).map((g) => g.line);
  return top.length > 0 ? [`Scoreboard: ${top.join(" · ")}`] : [];
}

/* --------------------------------- digest -------------------------------- */

/**
 * The bar's off-protocol wire: a few Polymarket lines and tonight's scores.
 * Every source degrades independently; an empty wire returns a note instead
 * of throwing, so the forum round never depends on any upstream.
 */
export async function barWireDigest(): Promise<string> {
  const [poly, espn] = await Promise.allSettled([
    cached("bar:polymarket", WIRE_TTL_MS, polymarketLines),
    cached("bar:espn", WIRE_TTL_MS, espnLines),
  ]);
  const lines: string[] = [];
  if (poly.status === "fulfilled") lines.push(...poly.value.data);
  if (espn.status === "fulfilled") lines.push(...espn.value.data);
  return lines.length > 0
    ? lines.join("\n")
    : "(off-protocol feeds unreachable right now; the intel above is tonight's wire)";
}
