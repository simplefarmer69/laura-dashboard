import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * ESPN scoreboard feed  -  live and upcoming games across the major US
 * leagues via ESPN's public site API, merged into one list. Live games
 * sort first, then upcoming by start time.
 */

export const dynamic = "force-dynamic";

const LEAGUES: Array<{ key: string; path: string }> = [
  { key: "NFL", path: "football/nfl" },
  { key: "MLB", path: "baseball/mlb" },
  { key: "NBA", path: "basketball/nba" },
];

type EspnScoreboard = {
  events?: Array<{
    id: string;
    shortName?: string;
    date?: string;
    status?: { type?: { state?: string; shortDetail?: string; completed?: boolean } };
    competitions?: Array<{
      competitors?: Array<{
        homeAway?: string;
        score?: string;
        team?: { abbreviation?: string; displayName?: string };
      }>;
    }>;
  }>;
};

type Game = {
  id: string;
  league: string;
  shortName: string;
  state: string; // pre | in | post
  detail: string;
  start: string | null;
  home: { abbr: string; score: string | null };
  away: { abbr: string; score: string | null };
};

async function load(): Promise<Game[]> {
  const boards = await Promise.allSettled(
    LEAGUES.map(async (l) => ({
      league: l.key,
      board: await getJson<EspnScoreboard>(
        `https://site.api.espn.com/apis/site/v2/sports/${l.path}/scoreboard`,
        10_000,
      ),
    })),
  );

  const games: Game[] = [];
  for (const r of boards) {
    if (r.status !== "fulfilled") continue; // one dark league never blanks the rest
    for (const e of r.value.board.events ?? []) {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      const away = comp?.competitors?.find((c) => c.homeAway === "away");
      if (!home?.team?.abbreviation || !away?.team?.abbreviation) continue;
      games.push({
        id: `${r.value.league}:${e.id}`,
        league: r.value.league,
        shortName: e.shortName ?? `${away.team.abbreviation} @ ${home.team.abbreviation}`,
        state: e.status?.type?.state ?? "pre",
        detail: e.status?.type?.shortDetail ?? "",
        start: e.date ?? null,
        home: { abbr: home.team.abbreviation, score: home.score ?? null },
        away: { abbr: away.team.abbreviation, score: away.score ?? null },
      });
    }
  }

  const rank = (g: Game) => (g.state === "in" ? 0 : g.state === "pre" ? 1 : 2);
  games.sort((a, b) => rank(a) - rank(b) || (a.start ?? "").localeCompare(b.start ?? ""));
  return games.slice(0, 14);
}

export async function GET() {
  try {
    const res = await cached("espn", 60_000, load);
    return feedResponse({ ok: true, stale: res.stale, updatedAt: res.at, games: res.data }, 30);
  } catch (err) {
    return feedError(err instanceof Error ? err.message : "espn feed failed");
  }
}
