"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CandlestickChart, Gem, Waves } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ago, pct, usd } from "@/components/console/format";
import type { NftBuysData } from "@/components/console/feeds";

/**
 * Intel feed panels for LAURA's three data agents: Bands (Smart LP balanced
 * band study), Curator (NFT trends on Robinhood Chain + Ethereum) and Ticker
 * (DexScreener token tape). Each panel renders one /api/feeds/* payload and
 * names the agent that consumes it.
 */

/* ---------- types mirroring the /api/feeds/* payloads ---------- */

export type SmartLpData = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  ethUsd: number | null;
  mechanics: {
    bandTicks: number;
    recenterTriggerTicks: number;
    recenterCooldownHours: number;
    perfFeeBps: number;
    withdrawFeeBps: number;
  };
  fleet: {
    vaults: number;
    bbVaults: number;
    tvlUsd: number;
    compounds: number;
    collects: number;
    recenters: number;
    activityAt: number | null;
  };
  bb: Array<{
    vault: string;
    base: string;
    quote: string;
    feePct: number;
    tvlUsd: number | null;
    bandPct: number;
    halfWidthPct: number;
    edgeTicks: number;
    nearEdge: boolean;
    compounds: number;
    recenters: number;
    lastActivityTs: number | null;
    lastRecenterAt: number | null;
    paused: boolean;
  }>;
};

export type NftTrendsData = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  robinhood: {
    broker: { holders: number; transfers: number; supply: number | null } | null;
    collections: Array<{ address: string; name: string; symbol: string; holders: number; supply: number | null }>;
  };
  ethereum: {
    collections: Array<{ address: string; name: string; symbol: string; holders: number; supply: number | null }>;
  };
};

export type TokenTapeData = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  tracked: number;
  rows: Array<{
    address: string;
    symbol: string;
    name: string;
    priceUsd: number;
    change24hPct: number | null;
    volume24hUsd: number | null;
    liquidityUsd: number | null;
    quoteSymbol: string;
    pinned: boolean;
  }>;
};

/* ---------- polling hook (same shape as useFeeds) ---------- */

const INTEL_FEEDS = [
  { key: "smartlp", path: "/api/feeds/smartlp", everyMs: 120_000 },
  { key: "nftTrends", path: "/api/feeds/nft-trends", everyMs: 300_000 },
  { key: "tokens", path: "/api/feeds/tokens", everyMs: 90_000 },
] as const;

export function useIntelFeeds() {
  const [smartlp, setSmartlp] = useState<SmartLpData | null>(null);
  const [nftTrends, setNftTrends] = useState<NftTrendsData | null>(null);
  const [tokens, setTokens] = useState<TokenTapeData | null>(null);
  const inflight = useRef<Set<string>>(new Set());

  const setters = useRef({ smartlp: setSmartlp, nftTrends: setNftTrends, tokens: setTokens });

  const poll = useCallback(async (key: (typeof INTEL_FEEDS)[number]["key"], path: string) => {
    if (inflight.current.has(path)) return;
    inflight.current.add(path);
    try {
      const res = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
      if (res.ok) {
        const body = await res.json();
        if (body?.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (setters.current[key] as (v: any) => void)(body);
        }
      }
    } catch {
      /* keep the last good payload on screen */
    } finally {
      inflight.current.delete(path);
    }
  }, []);

  useEffect(() => {
    const timers = INTEL_FEEDS.map((f) => {
      void poll(f.key, f.path);
      return setInterval(() => void poll(f.key, f.path), f.everyMs);
    });
    return () => timers.forEach(clearInterval);
  }, [poll]);

  return { smartlp, nftTrends, tokens };
}

/* ---------- shared bits ---------- */

function AgentChip({ name, role }: { name: string; role: string }) {
  return (
    <span className="sb-chip font-mono text-[9px] text-[var(--sb-green)]">
      {name} · {role}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-border/60 bg-muted/20 p-2.5">
      <p className="sb-label">{label}</p>
      <p className="font-mono text-base">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** Where spot sits inside a balanced band: center tick + spot marker. */
function BandBar({ pos, nearEdge }: { pos: number; nearEdge: boolean }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <div
        className={`absolute inset-y-0 w-1 rounded-full ${nearEdge ? "bg-[var(--sb-volt)]" : "bg-[var(--sb-green)]"}`}
        style={{ left: `calc(${Math.min(98, Math.max(0, pos))}% - 1px)` }}
      />
    </div>
  );
}

/* ---------- Smart LP balanced band study (full width section) ---------- */

export function SmartLpStudySection({ data }: { data: SmartLpData | null }) {
  const m = data?.mechanics;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Waves className="size-3.5 text-[var(--sb-green)]" /> Smart LP · balanced band study
          </CardTitle>
          <div className="flex items-center gap-2">
            <AgentChip name="Bands" role="Smart LP analyst" />
            {data?.stale && (
              <Badge variant="outline" className="font-mono text-[10px] text-[var(--sb-gold)]">
                stale snapshot
              </Badge>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          LAURA studies the balanced band vaults of the Safety Deposit Box Smart LP fleet on Robinhood Uniswap v3.
          She tracks fee velocity, time in band, recenter cadence and TVL per vault, and proposes small algo
          adjustments. Adjustments are proposals only. The operator approves and executes.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Fleet TVL" value={usd(data.fleet.tvlUsd)} sub={`${data.fleet.vaults} vaults live`} />
              <Stat label="Balanced band" value={String(data.fleet.bbVaults)} sub="vaults in this study" />
              <Stat label="Compounds" value={data.fleet.compounds.toLocaleString()} sub="fees rolled back in" />
              <Stat label="Collects" value={data.fleet.collects.toLocaleString()} sub="fee harvests" />
              <Stat label="Recenters" value={data.fleet.recenters.toLocaleString()} sub="band moves, fleet wide" />
              <Stat
                label="ETH mark"
                value={data.ethUsd ? usd(data.ethUsd) : "—"}
                sub="prices WETH quoted vaults"
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-left">
                    <th className="sb-label py-1.5 pr-2 font-normal">Vault</th>
                    <th className="sb-label py-1.5 pr-2 font-normal">TVL</th>
                    <th className="sb-label w-[26%] py-1.5 pr-2 font-normal">Spot in band</th>
                    <th className="sb-label py-1.5 pr-2 text-right font-normal">Edge ticks</th>
                    <th className="sb-label py-1.5 pr-2 text-right font-normal">Compounds</th>
                    <th className="sb-label py-1.5 pr-2 text-right font-normal">Recenters</th>
                    <th className="sb-label py-1.5 text-right font-normal">Last touch</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bb.map((v) => (
                    <tr key={v.vault} className="border-b border-border/40">
                      <td className="py-1.5 pr-2">
                        <span className="text-foreground">
                          {v.base}/{v.quote}
                        </span>
                        <span className="text-muted-foreground"> · {v.feePct}%</span>
                        {v.paused && <span className="text-[var(--sb-gold)]"> · deposits paused</span>}
                      </td>
                      <td className="py-1.5 pr-2 font-mono">{usd(v.tvlUsd)}</td>
                      <td className="py-1.5 pr-2">
                        <BandBar pos={v.bandPct} nearEdge={v.nearEdge} />
                      </td>
                      <td
                        className={`py-1.5 pr-2 text-right font-mono ${
                          v.nearEdge ? "text-[var(--sb-volt)]" : "text-muted-foreground"
                        }`}
                      >
                        {v.edgeTicks}
                        {v.nearEdge ? " · near" : ""}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono text-muted-foreground">{v.compounds}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-muted-foreground">{v.recenters}</td>
                      <td className="py-1.5 text-right font-mono text-[10px] text-muted-foreground">
                        {v.lastActivityTs ? ago(v.lastActivityTs) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {m && (
              <p className="border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
                How a balanced band works: the position spans the 30 minute TWAP ±{m.bandTicks} ticks (about ±
                {(Math.pow(1.0001, m.bandTicks) * 100 - 100).toFixed(1)}% in price). The keeper recenters only when
                the TWAP drifts within {m.recenterTriggerTicks} ticks of a band edge, with a{" "}
                {m.recenterCooldownHours}h onchain cooldown, so stock vaults recenter a few times a month at most.
                Collected fees compound back into the position. A {m.perfFeeBps / 100}% performance fee applies to
                collected fees only, and a {m.withdrawFeeBps} bps withdraw retention stays in the vault for
                remaining holders. Top {data.bb.length} of {data.fleet.bbVaults} balanced band vaults by TVL shown.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Reading the vault fleet through the Smart LP lens…</p>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------- NFT trends (Curator) ---------- */

function CollectionRows({
  rows,
  tone,
}: {
  rows: NftTrendsData["robinhood"]["collections"];
  tone: string;
}) {
  return (
    <ul className="space-y-1">
      {rows.map((c) => (
        <li key={c.address} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-foreground">{c.name}</span>
          <span className={`font-mono text-[11px] ${tone}`}>{c.holders.toLocaleString()}</span>
          <span className="w-14 text-right font-mono text-[10px] text-muted-foreground">
            {c.supply ? `${c.supply.toLocaleString()} nft` : "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function NftTrendsPanel({ data, buys }: { data: NftTrendsData | null; buys: NftBuysData | null }) {
  const daySales = (buys?.sales ?? []).filter((s) => Date.now() - s.ts < 86_400_000);
  const dayEth = daySales.reduce((a, s) => a + s.priceEth, 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gem className="size-3.5 text-[var(--sb-gold)]" /> NFT trends
          </CardTitle>
          <AgentChip name="Curator" role="NFT intel" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Collection stats via Blockscout on both chains · holders as the durable trend signal
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {data ? (
          <>
            <div>
              <p className="sb-label mb-1">Robinhood Chain</p>
              {data.robinhood.broker && (
                <p className="mb-1.5 text-xs text-muted-foreground">
                  StonkBrokers:{" "}
                  <span className="font-mono text-[var(--sb-green)]">
                    {data.robinhood.broker.holders.toLocaleString()}
                  </span>{" "}
                  holders · {data.robinhood.broker.transfers.toLocaleString()} lifetime transfers
                  {daySales.length > 0 && (
                    <>
                      {" "}
                      · {daySales.length} sale{daySales.length === 1 ? "" : "s"} / {dayEth.toFixed(3)} ETH last 24h
                    </>
                  )}
                </p>
              )}
              <CollectionRows rows={data.robinhood.collections.slice(0, 5)} tone="text-[var(--sb-green)]" />
            </div>
            <div className="border-t border-border/60 pt-2">
              <p className="sb-label mb-1">Ethereum blue chips</p>
              {data.ethereum.collections.length > 0 ? (
                <CollectionRows rows={data.ethereum.collections} tone="text-[var(--sb-gold)]" />
              ) : (
                <p className="text-xs text-muted-foreground">Ethereum lane source pending.</p>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Reading collection stats…</p>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------- Token tape (Ticker) ---------- */

export function TokenTapePanel({ data }: { data: TokenTapeData | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CandlestickChart className="size-3.5 text-primary" /> Token tape
          </CardTitle>
          <AgentChip name="Ticker" role="token intel" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          DexScreener marks for $STONKBROKER and the largest bonded launcher tokens · pairs vetted by quote side
          depth
        </p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {(data?.rows ?? []).slice(0, 8).map((t) => (
            <li key={t.address} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">
                <span className="text-foreground">{t.symbol}</span>
                {t.pinned && <span className="text-[10px] text-[var(--sb-green)]"> · house token</span>}
              </span>
              <span className="font-mono text-[11px]">{usd(t.priceUsd)}</span>
              <span
                className={`w-16 text-right font-mono text-[11px] ${
                  (t.change24hPct ?? 0) >= 0 ? "text-[var(--sb-green)]" : "text-destructive"
                }`}
              >
                {pct(t.change24hPct)}
              </span>
              <span className="w-14 text-right font-mono text-[10px] text-muted-foreground">
                {usd(t.volume24hUsd)}
              </span>
            </li>
          ))}
          {data && data.rows.length === 0 && (
            <li className="text-xs text-muted-foreground">No vetted pairs on the tape right now.</li>
          )}
          {!data && <li className="text-xs text-muted-foreground">Reading the tape…</li>}
        </ul>
        {data && (
          <p className="mt-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {data.rows.length} of {data.tracked} tracked tokens passed vetting · price / 24h / volume
          </p>
        )}
      </CardContent>
    </Card>
  );
}
