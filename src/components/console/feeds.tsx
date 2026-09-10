"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, BarChart3, CalendarClock, Landmark, Rocket, Trophy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ago, usd } from "@/components/console/format";

/**
 * Live external data feeds for the swarm: Stonklauncher buys (the Telegram
 * bot's onchain tape), StonkBroker NFT buys (the OpenSea buybot's Seaport
 * scan), Polymarket prediction markets, and ESPN scores - plus a running log
 * of every API call the console makes, rendered under Live actions.
 */

/* ---------- types mirroring the /api/feeds/* payloads ---------- */

export type LauncherFeedData = {
  ok: boolean;
  updatedAt: number;
  ethUsd: number | null;
  buys: Array<{
    key: string;
    launchId: number;
    name: string;
    symbol: string;
    phase: string;
    buyer: string;
    eth: number;
    paidIn: string;
    mcapUsd: number | null;
    ts: number;
  }>;
  stats: {
    launches: number;
    bonded: number;
    buys: number;
    uniqueBuyers: number;
    grossBuyEth: number;
    taxEth: number;
  } | null;
};

export type NftBuysData = {
  ok: boolean;
  updatedAt: number;
  headBlock: number;
  sales: Array<{
    tx: string;
    tokenId: string;
    priceEth: number;
    buyer: string;
    block: number;
    ts: number;
  }>;
};

export type PolymarketData = {
  ok: boolean;
  updatedAt: number;
  markets: Array<{
    question: string;
    url: string | null;
    outcomes: Array<{ label: string; price: number | null }>;
    volume24hrUsd: number | null;
    endDate: string | null;
  }>;
};

export type EspnData = {
  ok: boolean;
  updatedAt: number;
  games: Array<{
    id: string;
    league: string;
    shortName: string;
    state: string;
    detail: string;
    home: { abbr: string; score: string | null };
    away: { abbr: string; score: string | null };
  }>;
};

export type DlPoint = { t: number; usd: number };

export type DefillamaData = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  protocolUrl: string;
  tvl: { currentUsd: number | null; stakingUsd: number | null; series: DlPoint[] };
  fees: {
    total24hUsd: number | null;
    total7dUsd: number | null;
    total30dUsd: number | null;
    cumulativeUsd: number | null;
    series: DlPoint[];
  };
  revenue: {
    total24hUsd: number | null;
    total7dUsd: number | null;
    cumulativeUsd: number | null;
    series: DlPoint[];
  };
  dexVolume: {
    name: string;
    total24hUsd: number | null;
    total7dUsd: number | null;
    cumulativeUsd: number | null;
    series: DlPoint[];
  };
};

export type ApiCall = {
  id: number;
  path: string;
  status: number | null;
  ms: number;
  at: number;
  ok: boolean;
};

/* ---------- the polling hook ---------- */

const FEEDS: Array<{
  key: "launcher" | "nftBuys" | "polymarket" | "espn" | "defillama";
  path: string;
  everyMs: number;
}> = [
  { key: "launcher", path: "/api/feeds/launcher", everyMs: 15_000 },
  { key: "nftBuys", path: "/api/feeds/nft-buys", everyMs: 45_000 },
  { key: "polymarket", path: "/api/feeds/polymarket", everyMs: 60_000 },
  { key: "espn", path: "/api/feeds/espn", everyMs: 60_000 },
  { key: "defillama", path: "/api/feeds/defillama", everyMs: 300_000 },
];

let callSeq = 1;

export function useFeeds() {
  const [launcher, setLauncher] = useState<LauncherFeedData | null>(null);
  const [nftBuys, setNftBuys] = useState<NftBuysData | null>(null);
  const [polymarket, setPolymarket] = useState<PolymarketData | null>(null);
  const [espn, setEspn] = useState<EspnData | null>(null);
  const [defillama, setDefillama] = useState<DefillamaData | null>(null);
  const [calls, setCalls] = useState<ApiCall[]>([]);
  const inflight = useRef<Set<string>>(new Set());

  const setters = useRef({
    launcher: setLauncher,
    nftBuys: setNftBuys,
    polymarket: setPolymarket,
    espn: setEspn,
    defillama: setDefillama,
  });

  const poll = useCallback(async (key: (typeof FEEDS)[number]["key"], path: string) => {
    if (inflight.current.has(path)) return;
    inflight.current.add(path);
    const started = performance.now();
    let status: number | null = null;
    let ok = false;
    try {
      const res = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      status = res.status;
      if (res.ok) {
        const body = await res.json();
        if (body?.ok) {
          ok = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (setters.current[key] as (v: any) => void)(body);
        }
      }
    } catch {
      /* logged below as a failed call */
    } finally {
      inflight.current.delete(path);
      const entry: ApiCall = {
        id: callSeq++,
        path,
        status,
        ms: Math.round(performance.now() - started),
        at: Date.now(),
        ok,
      };
      setCalls((prev) => [entry, ...prev].slice(0, 30));
    }
  }, []);

  useEffect(() => {
    const timers = FEEDS.map((f) => {
      void poll(f.key, f.path);
      return setInterval(() => void poll(f.key, f.path), f.everyMs);
    });
    return () => timers.forEach(clearInterval);
  }, [poll]);

  return { launcher, nftBuys, polymarket, espn, defillama, calls };
}

/* ---------- helpers ---------- */

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function eth(n: number): string {
  if (n >= 100) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

/* ---------- Live API calls (fills the space under Live actions) ---------- */

export function LiveApiCalls({ calls }: { calls: ApiCall[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="size-3.5 text-[var(--sb-volt)]" /> Live API calls
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {calls.slice(0, 10).map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-xs">
              <span
                className={`sb-chip font-mono text-[9px] ${c.ok ? "text-[var(--sb-green)]" : "text-[var(--sb-neg)]"}`}
              >
                {c.status ?? "ERR"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85">
                GET {c.path.replace("/api/feeds/", "feeds/")}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">{c.ms}ms</span>
              <span className="w-10 text-right font-mono text-[10px] text-muted-foreground">{ago(c.at)}</span>
            </li>
          ))}
          {calls.length === 0 && <li className="text-xs text-muted-foreground">Waiting for the first poll…</li>}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------- feed panels ---------- */

export function LauncherFeedPanel({ data }: { data: LauncherFeedData | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Rocket className="size-3.5 text-primary" /> Stonklauncher buys
          </CardTitle>
          {data?.stats && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {data.stats.launches.toLocaleString()} launches · {data.stats.bonded} bonded
            </Badge>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">Robinhood Chain launchpad tape · the Telegram bot&apos;s onchain data</p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {(data?.buys ?? []).slice(0, 6).map((b) => (
            <li key={b.key} className="flex items-center gap-2 text-xs">
              <span className="sb-chip font-mono text-[9px] text-[var(--sb-green)]">BUY</span>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-foreground">{b.symbol || b.name}</span>
                <span className="text-muted-foreground"> · {shortAddr(b.buyer)}</span>
              </span>
              <span className="font-mono text-[11px] text-[var(--sb-green)]">{eth(b.eth)} {b.paidIn}</span>
              <span className="w-10 text-right font-mono text-[10px] text-muted-foreground">{ago(b.ts)}</span>
            </li>
          ))}
          {data && data.buys.length === 0 && (
            <li className="text-xs text-muted-foreground">No buys on the tape right now.</li>
          )}
          {!data && <li className="text-xs text-muted-foreground">Loading the launch tape…</li>}
        </ul>
        {data?.stats && (
          <p className="mt-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {data.stats.buys.toLocaleString()} buys all time · {data.stats.uniqueBuyers.toLocaleString()} buyers ·{" "}
            {data.stats.grossBuyEth.toFixed(0)} ETH gross
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function NftBuysPanel({ data }: { data: NftBuysData | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Landmark className="size-3.5 text-[var(--sb-gold)]" /> Broker NFT buys
          </CardTitle>
          {data && (
            <Badge variant="outline" className="font-mono text-[10px]">
              block {data.headBlock.toLocaleString()}
            </Badge>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">Seaport sales of StonkBroker NFTs · the OpenSea buybot&apos;s source</p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {(data?.sales ?? []).slice(0, 6).map((s) => (
            <li key={`${s.tx}:${s.tokenId}`} className="flex items-center gap-2 text-xs">
              <span className="sb-chip font-mono text-[9px] text-[var(--sb-gold)]">SOLD</span>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-foreground">Broker #{s.tokenId}</span>
                <span className="text-muted-foreground"> · {shortAddr(s.buyer)}</span>
              </span>
              <span className="font-mono text-[11px] text-[var(--sb-gold)]">{eth(s.priceEth)} ETH</span>
              <span className="w-10 text-right font-mono text-[10px] text-muted-foreground">{ago(s.ts)}</span>
            </li>
          ))}
          {data && data.sales.length === 0 && (
            <li className="text-xs text-muted-foreground">No broker sales in the scan window yet.</li>
          )}
          {!data && <li className="text-xs text-muted-foreground">Scanning Seaport logs…</li>}
        </ul>
      </CardContent>
    </Card>
  );
}

export function PolymarketPanel({ data }: { data: PolymarketData | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarClock className="size-3.5 text-[var(--sb-volt)]" /> Polymarket
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">Top prediction markets by 24h volume</p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {(data?.markets ?? []).slice(0, 5).map((m) => {
            const yes = m.outcomes.find((o) => o.label.toLowerCase() === "yes") ?? m.outcomes[0];
            return (
              <li key={m.question} className="text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-foreground/90">{m.question}</span>
                  {yes?.price != null && (
                    <span className="sb-chip font-mono text-[10px] text-[var(--sb-volt)]">
                      {yes.label} {(yes.price * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {m.volume24hrUsd != null ? `${usd(m.volume24hrUsd, 0)} 24h vol` : ""}
                </p>
              </li>
            );
          })}
          {!data && <li className="text-xs text-muted-foreground">Loading markets…</li>}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------- DeFiLlama section (high detail SVG charts, no chart lib) ---------- */

const DL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dlDay(t: number): string {
  const d = new Date(t * 1000);
  return `${DL_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const DL_W = 640;
const DL_PAD_L = 56;
const DL_PAD_R = 14;
const DL_PAD_T = 16;
const DL_PAD_B = 24;

function DlAxis({ lo, hi, y }: { lo: number; hi: number; y: (v: number) => number }) {
  // Gridlines at 25% intervals of the value range.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + (hi - lo) * f);
  return (
    <>
      {ticks.map((t, i) => (
        <g key={i}>
          <line
            x1={DL_PAD_L}
            x2={DL_W - DL_PAD_R}
            y1={y(t)}
            y2={y(t)}
            stroke="rgba(255,255,255,0.08)"
            strokeDasharray="2 4"
          />
          <text
            x={DL_PAD_L - 8}
            y={y(t) + 3}
            textAnchor="end"
            fontSize="10"
            fill="var(--muted-foreground)"
            fontFamily="var(--font-mono)"
          >
            {usd(t, 0)}
          </text>
        </g>
      ))}
    </>
  );
}

function DlXLabels({ series, x, height }: { series: DlPoint[]; x: (i: number) => number; height: number }) {
  const every = Math.max(1, Math.ceil(series.length / 6));
  return (
    <>
      {series.map((p, i) =>
        i % every === 0 ? (
          <text
            key={p.t}
            x={x(i)}
            y={height - 8}
            textAnchor="middle"
            fontSize="10"
            fill="var(--muted-foreground)"
            fontFamily="var(--font-mono)"
          >
            {dlDay(p.t)}
          </text>
        ) : null,
      )}
    </>
  );
}

/** Area chart for a daily USD series (TVL). ~200px tall, full card width. */
function DlAreaChart({ series, color, height = 200 }: { series: DlPoint[]; color: string; height?: number }) {
  if (series.length < 2) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        Collecting history…
      </div>
    );
  }
  const values = series.map((p) => p.usd);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  const innerW = DL_W - DL_PAD_L - DL_PAD_R;
  const innerH = height - DL_PAD_T - DL_PAD_B;
  const x = (i: number) => DL_PAD_L + (i / (series.length - 1)) * innerW;
  const y = (v: number) => DL_PAD_T + innerH - ((v - lo) / span) * innerH;
  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.usd).toFixed(1)}`).join(" ");
  const area = `${path} L${x(series.length - 1).toFixed(1)},${(DL_PAD_T + innerH).toFixed(1)} L${x(0).toFixed(1)},${(DL_PAD_T + innerH).toFixed(1)} Z`;
  const last = series[series.length - 1];
  return (
    <svg viewBox={`0 0 ${DL_W} ${height}`} className="h-auto w-full" role="img">
      <DlAxis lo={lo} hi={hi} y={y} />
      <path d={area} fill={color} opacity={0.1} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.75} />
      <circle cx={x(series.length - 1)} cy={y(last.usd)} r={3} fill={color} />
      <text
        x={DL_W - DL_PAD_R}
        y={Math.max(DL_PAD_T + 10, y(last.usd) - 8)}
        textAnchor="end"
        fontSize="11"
        fill={color}
        fontFamily="var(--font-mono)"
      >
        {usd(last.usd, 0)}
      </text>
      <DlXLabels series={series} x={x} height={height} />
    </svg>
  );
}

/** Bar chart for a daily USD series (fees), with an optional overlay series (revenue). */
function DlBarChart({
  series,
  overlay,
  color,
  overlayColor,
  height = 200,
}: {
  series: DlPoint[];
  overlay?: DlPoint[];
  color: string;
  overlayColor?: string;
  height?: number;
}) {
  if (series.length < 2) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        Collecting history…
      </div>
    );
  }
  const overlayByT = new Map((overlay ?? []).map((p) => [p.t, p.usd]));
  const hi = Math.max(...series.map((p) => p.usd), 1);
  const lo = 0;
  const innerW = DL_W - DL_PAD_L - DL_PAD_R;
  const innerH = height - DL_PAD_T - DL_PAD_B;
  const slot = innerW / series.length;
  const barW = Math.max(1, slot * 0.62);
  const x = (i: number) => DL_PAD_L + i * slot + (slot - barW) / 2;
  const xc = (i: number) => DL_PAD_L + i * slot + slot / 2;
  const y = (v: number) => DL_PAD_T + innerH - ((v - lo) / (hi - lo)) * innerH;
  const last = series[series.length - 1];
  return (
    <svg viewBox={`0 0 ${DL_W} ${height}`} className="h-auto w-full" role="img">
      <DlAxis lo={lo} hi={hi} y={y} />
      {series.map((p, i) => {
        const ov = overlayByT.get(p.t);
        return (
          <g key={p.t}>
            <rect x={x(i)} y={y(p.usd)} width={barW} height={Math.max(0.5, DL_PAD_T + innerH - y(p.usd))} fill={color} opacity={0.55} />
            {ov != null && overlayColor && (
              <rect
                x={x(i)}
                y={y(Math.min(ov, p.usd))}
                width={barW}
                height={Math.max(0.5, DL_PAD_T + innerH - y(Math.min(ov, p.usd)))}
                fill={overlayColor}
                opacity={0.85}
              />
            )}
          </g>
        );
      })}
      <text
        x={DL_W - DL_PAD_R}
        y={Math.max(DL_PAD_T + 10, y(last.usd) - 6)}
        textAnchor="end"
        fontSize="11"
        fill={color}
        fontFamily="var(--font-mono)"
      >
        {usd(last.usd, 0)}
      </text>
      <DlXLabels series={series} x={xc} height={height} />
    </svg>
  );
}

function DlStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="border border-border/60 bg-muted/20 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`font-mono text-base ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

export function DefillamaPanel({ data }: { data: DefillamaData | null }) {
  const url = data?.protocolUrl ?? "https://defillama.com/protocol/stonkbrokers";
  return (
    <Card className="sb-panel">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="size-3.5 text-primary" /> DeFiLlama · StonkBrokers protocol
          </CardTitle>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="sb-chip font-mono text-[10px] text-[var(--sb-volt)] transition-colors hover:text-[var(--sb-gold)]"
          >
            DeFiLlama -&gt;
          </a>
        </div>
        <p className="text-[11px] text-muted-foreground">
          TVL, fees and revenue from the public DeFiLlama listing · Anvil AMM volume as the secondary series
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <DlStat label="TVL · Robinhood Chain" value={usd(data?.tvl.currentUsd, 0)} tone="text-[var(--sb-accent)]" />
          <DlStat label="Staked · soft staking" value={usd(data?.tvl.stakingUsd, 0)} />
          <DlStat label="Fees 24h" value={usd(data?.fees.total24hUsd, 0)} tone="text-[var(--sb-volt)]" />
          <DlStat label="Fees 7d" value={usd(data?.fees.total7dUsd, 0)} tone="text-[var(--sb-volt)]" />
          <DlStat label="Fees cumulative" value={usd(data?.fees.cumulativeUsd, 0)} />
          <DlStat label="Revenue 24h" value={usd(data?.revenue.total24hUsd, 0)} tone="text-[var(--sb-gold)]" />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] text-muted-foreground">
              <span className="text-[var(--sb-accent)]">TVL</span> · Robinhood Chain · daily
            </p>
            <DlAreaChart series={data?.tvl.series ?? []} color="var(--sb-accent)" />
          </div>
          <div>
            <p className="mb-1 text-[11px] text-muted-foreground">
              <span className="text-[var(--sb-volt)]">Daily fees</span> ·{" "}
              <span className="text-[var(--sb-gold)]">revenue</span> overlaid
            </p>
            <DlBarChart
              series={data?.fees.series ?? []}
              overlay={data?.revenue.series ?? []}
              color="var(--sb-volt)"
              overlayColor="var(--sb-gold)"
            />
          </div>
        </div>

        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">
            <span className="text-[var(--sb-green)]">Anvil AMM daily volume</span> · {data?.dexVolume.name ?? "Clutch Anvil AMM"} ·
            cumulative {usd(data?.dexVolume.cumulativeUsd, 0)}
          </p>
          <DlBarChart series={data?.dexVolume.series ?? []} color="var(--sb-green)" height={150} />
        </div>
      </CardContent>
    </Card>
  );
}

export function EspnPanel({ data }: { data: EspnData | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Trophy className="size-3.5 text-[var(--sb-green)]" /> ESPN scores
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">Live and upcoming games · NFL, MLB, NBA</p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {(data?.games ?? []).slice(0, 6).map((g) => (
            <li key={g.id} className="flex items-center gap-2 text-xs">
              <span
                className={`sb-chip font-mono text-[9px] ${
                  g.state === "in" ? "text-[var(--sb-green)]" : "text-muted-foreground"
                }`}
              >
                {g.league}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {g.away.abbr} {g.away.score ?? ""} @ {g.home.abbr} {g.home.score ?? ""}
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">{g.detail}</span>
            </li>
          ))}
          {!data && <li className="text-xs text-muted-foreground">Loading scoreboards…</li>}
        </ul>
      </CardContent>
    </Card>
  );
}
