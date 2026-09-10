"use client";

import { useMemo } from "react";
import { Brain, Crown, Megaphone, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LineChart, type ChartPoint } from "@/components/console/chart";
import { ago, usd } from "@/components/console/format";
import type { ConsoleState } from "@/components/console/use-swarm-state";
import { MILESTONES } from "@/lib/mission-status";
import type { IntelSnapshot, MetricsSnapshot } from "@/lib/types";

/** Last snapshot per UTC day so charts stay readable as history grows. */
function dailySeries(history: MetricsSnapshot[], pick: (m: MetricsSnapshot) => number): ChartPoint[] {
  const byDay = new Map<string, MetricsSnapshot>();
  for (const m of history) byDay.set(new Date(m.ts).toISOString().slice(0, 10), m);
  return [...byDay.entries()].map(([day, m]) => ({ label: day.slice(5), value: pick(m) }));
}

/** Last intel snapshot per UTC day, values picked with nulls dropped. */
function dailyIntelSeries(history: IntelSnapshot[], pick: (s: IntelSnapshot) => number | null): ChartPoint[] {
  const byDay = new Map<string, IntelSnapshot>();
  for (const s of history) byDay.set(new Date(s.ts).toISOString().slice(0, 10), s);
  return [...byDay.entries()]
    .map(([day, s]) => ({ label: day.slice(5), value: pick(s) }))
    .filter((p): p is ChartPoint => p.value !== null);
}

export function Growth({ state }: { state: ConsoleState }) {
  const mcapSeries = useMemo(() => dailySeries(state.metricsHistory, (m) => m.marketCapUsd), [state.metricsHistory]);
  const revenueSeries = useMemo(
    () => dailySeries(state.metricsHistory, (m) => m.protocolRevenue24hUsd),
    [state.metricsHistory],
  );
  const volumeSeries = useMemo(
    () => dailySeries(state.metricsHistory, (m) => m.protocolVolume24hUsd),
    [state.metricsHistory],
  );
  const gradeSeries: ChartPoint[] = state.grades.map((g) => ({ label: g.date.slice(5), value: g.score }));
  const mission = state.mission;
  const lessons = [...state.lessons].sort((a, b) => b.ts - a.ts);
  const intelHistory = useMemo(() => state.intelHistory ?? [], [state.intelHistory]);
  const intel = intelHistory.at(-1) ?? null;
  const mentionSeries = useMemo(
    () => dailyIntelSeries(intelHistory, (s) => s.x?.mentionCount24h ?? null),
    [intelHistory],
  );
  const engagementSeries = useMemo(
    () => dailyIntelSeries(intelHistory, (s) => s.x?.engagement24h ?? null),
    [intelHistory],
  );
  const holderSeries = useMemo(
    () => dailyIntelSeries(intelHistory, (s) => s.holderCount),
    [intelHistory],
  );

  const scoreboard = state.agents
    .filter((a) => a.id !== "coach")
    .map((a) => {
      const current = state.grades.at(-1)?.score ?? null;
      const delta =
        a.gradeAtVersionAdoption !== null && current !== null ? current - a.gradeAtVersionAdoption : null;
      return { agent: a, delta, versions: a.history.length + 1 };
    });

  return (
    <div className="space-y-4">
      <Card className="sb-panel">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <Crown className="size-4 text-[var(--sb-gold)]" />
            <CardTitle className="sb-ticker text-xs text-muted-foreground">Mission · $1B market cap → LAURA leads the StonkBrokers DAIO</CardTitle>
            {mission.daioMandateActive && <Badge className="bg-[var(--sb-gold)] text-black">DAIO mandate active</Badge>}
          </div>
          <div className="flex flex-wrap items-end gap-6 pt-1">
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Market cap</p>
              <p className="sb-glow-text font-mono text-3xl text-primary">{usd(mission.marketCapUsd)}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide">To target</p>
              <p className="font-mono text-3xl">{Number.isFinite(mission.multipleToTarget) ? `${mission.multipleToTarget.toFixed(1)}x` : "—"}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide">All-time high (tracked)</p>
              <p className="font-mono text-3xl">{usd(mission.athMarketCapUsd)}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Next milestone</p>
              <p className="font-mono text-3xl">{mission.next ? mission.next.label.split(" ")[0] : "done"}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="relative h-3 w-full bg-muted">
            <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${(mission.progress * 100).toFixed(2)}%` }} />
            {MILESTONES.map((m) => {
              const pos = Math.log(m.marketCapUsd / 1_000_000) / Math.log(1000);
              const reached = state.milestones.some((r) => r.id === m.id);
              return (
                <div
                  key={m.id}
                  className={`absolute -top-1 h-5 w-px ${reached ? "bg-[var(--sb-gold)]" : "bg-foreground/40"}`}
                  style={{ left: `${(pos * 100).toFixed(2)}%` }}
                  title={m.label}
                />
              );
            })}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>$1M</span>
            {MILESTONES.map((m) => (
              <span key={m.id} className={state.milestones.some((r) => r.id === m.id) ? "text-[var(--sb-gold)]" : ""}>
                {m.label.split(" ")[0]}
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Log-scale ladder from $1M to $1B. Milestones are stamped the first time the deepest-pool market cap crosses
            them and are never un-stamped. The mandate itself is ratified by the foundation, not by this console.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Market cap (daily close)" points={mcapSeries} format={(v) => usd(v)} />
        <ChartCard title="Swarm grade (daily)" points={gradeSeries} format={(v) => v.toFixed(0)} yMin={0} yMax={100} color="var(--sb-green)" />
        <ChartCard title="Protocol revenue · 24h (daily)" points={revenueSeries} format={(v) => usd(v)} color="var(--sb-gold)" />
        <ChartCard title="Protocol volume · 24h (daily)" points={volumeSeries} format={(v) => usd(v)} color="#8e8e8a" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Megaphone className="size-4 text-primary" /> Influence · live internet reads
            </CardTitle>
            {intel && (
              <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                {intel.sources.length > 0 ? `sources: ${intel.sources.join(", ")}` : "no sources this cycle"} · {ago(intel.ts)}
              </Badge>
            )}
          </div>
          <CardDescription>
            X mentions and engagement on $STONKBROKER (read-only bearer), Robinhood leadership activity, and
            holder counts when Blockscout answers. Measured every cycle — influence is a number, not a feeling.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!intel && (
            <p className="text-xs text-muted-foreground">No intel snapshots yet. They land with the next cycle.</p>
          )}
          {intel && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="X mentions · 24h" value={intel.x ? intel.x.mentionCount24h.toLocaleString() : "n/a"} />
                <Stat label="X engagement · 24h" value={intel.x ? intel.x.engagement24h.toLocaleString() : "n/a"} sub="likes + RTs + replies" />
                <Stat label="Holders" value={intel.holderCount !== null ? intel.holderCount.toLocaleString() : "n/a"} sub={intel.holderCount === null ? "Blockscout unreachable" : "Blockscout"} />
                <Stat label="ETH" value={intel.ethUsd !== null ? usd(intel.ethUsd) : "n/a"} sub={intel.ethUsd24hChangePct !== null ? `${intel.ethUsd24hChangePct >= 0 ? "+" : ""}${intel.ethUsd24hChangePct.toFixed(1)}% 24h` : ""} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {mentionSeries.length > 1 && (
                  <ChartCard title="X mentions / 24h (daily)" points={mentionSeries} format={(v) => v.toFixed(0)} />
                )}
                {engagementSeries.length > 1 && (
                  <ChartCard title="X engagement / 24h (daily)" points={engagementSeries} format={(v) => v.toFixed(0)} color="var(--sb-gold)" />
                )}
                {holderSeries.length > 1 && (
                  <ChartCard title="Holders (daily)" points={holderSeries} format={(v) => v.toFixed(0)} color="var(--sb-green)" />
                )}
              </div>
              {intel.x && intel.x.topMentions.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Top live mentions</p>
                  <ul className="space-y-1.5">
                    {intel.x.topMentions.map((t) => (
                      <li key={t.id} className="border-l-2 border-primary/50 pl-3 text-xs">
                        <span className="text-foreground/90">{t.text}</span>
                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                          {t.likes}♥ {t.retweets}RT {t.replies}re
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {intel.x && intel.x.leaders.some((l) => l.tweets.length > 0) && (
                <div>
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Robinhood leadership · latest</p>
                  <ul className="space-y-1.5">
                    {intel.x.leaders.map((l) =>
                      l.tweets.slice(0, 1).map((t) => (
                        <li key={t.id} className="border-l-2 border-[var(--sb-gold)]/50 pl-3 text-xs">
                          <span className="font-mono text-[10px] text-[var(--sb-gold)]">@{l.username}</span>{" "}
                          <span className="text-foreground/90">{t.text}</span>
                          <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                            {t.likes.toLocaleString()}♥ · {t.impressions.toLocaleString()} views
                          </span>
                        </li>
                      )),
                    )}
                  </ul>
                </div>
              )}
              {intel.warnings.length > 0 && (
                <p className="text-xs text-amber-400/90">{intel.warnings.join(" · ")}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Brain className="size-4 text-[var(--sb-green)]" /> Swarm memory
            </CardTitle>
            <CardDescription>
              Lessons the coach distilled from grades and reviewer decisions. Injected into every producer prompt.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {lessons.length === 0 && <p className="text-xs text-muted-foreground">No lessons yet. They accrue as cycles run and reviewers act.</p>}
            <ul className="space-y-2">
              {lessons.slice(0, 15).map((l) => (
                <li key={l.id} className="border-l-2 border-[var(--sb-green)]/60 pl-3">
                  <p className="text-sm leading-snug">{l.text}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {l.evidence} · {ago(l.ts)}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="size-4 text-primary" /> Strategy scoreboard
            </CardTitle>
            <CardDescription>Grade movement since each agent&apos;s current strategy version went live.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {scoreboard.map(({ agent, delta, versions }) => (
              <div key={agent.id} className="flex items-center gap-3 border border-border/60 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {agent.name} <span className="font-mono text-xs text-muted-foreground">v{agent.strategyVersion}</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {versions} version{versions === 1 ? "" : "s"} · {agent.stats.approved} approved / {agent.stats.rejected} rejected
                  </p>
                </div>
                <div className="text-right">
                  <p className={`font-mono text-sm ${delta === null ? "text-muted-foreground" : delta >= 0 ? "text-[var(--sb-green)]" : "text-destructive"}`}>
                    {delta === null ? "baseline" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`}
                  </p>
                  <p className="text-[10px] text-muted-foreground">grade Δ since adoption</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-border/60 bg-muted/20 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono text-lg">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function ChartCard({
  title,
  points,
  format,
  color,
  yMin,
  yMax,
}: {
  title: string;
  points: ChartPoint[];
  format: (v: number) => string;
  color?: string;
  yMin?: number;
  yMax?: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="sb-ticker text-xs text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <LineChart points={points} format={format} color={color} yMin={yMin} yMax={yMax} />
      </CardContent>
    </Card>
  );
}
