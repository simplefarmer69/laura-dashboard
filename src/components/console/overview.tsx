"use client";

import { ArrowRight, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Sparkline } from "@/components/console/sparkline";
import { ago, gradeTone, pct, usd } from "@/components/console/format";
import type { ConsoleState } from "@/components/console/use-swarm-state";

export function Overview({
  state,
  onNavigate,
}: {
  state: ConsoleState;
  onNavigate: (tab: string) => void;
}) {
  const grade = state.grades.at(-1) ?? null;
  const metrics = state.metricsHistory.at(-1) ?? grade?.metrics ?? null;
  const brief = state.researchBriefs.at(-1) ?? null;
  const pending = state.drafts.filter((d) => d.status === "pending").length;
  const pendingProposals = state.proposals.filter((p) => p.status === "pending").length;
  const priceSeries = state.metricsHistory.map((m) => m.priceUsd);
  const gradeSeries = state.grades.map((g) => g.score);

  if (!grade || !metrics) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle>No cycle has run yet</CardTitle>
          <CardDescription>
            Press <span className="font-medium text-foreground">Run cycle</span> to pull live
            metrics from DexScreener and DefiLlama, grade the day, and let the six agents produce
            their first drafts and strategy proposals.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardDescription>Today&apos;s grade · {grade.date} UTC</CardDescription>
          <CardTitle className="flex items-end gap-3">
            <span className={`text-6xl font-semibold tracking-tight ${gradeTone(grade.letter)}`}>
              {grade.letter}
            </span>
            <span className="pb-2 font-mono text-xl text-muted-foreground">{grade.score.toFixed(1)}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {grade.components.map((c) => (
            <div key={c.key} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {c.label} <span className="opacity-60">· {(c.weight * 100).toFixed(0)}%</span>
                </span>
                <span className="font-mono">{c.score.toFixed(0)}</span>
              </div>
              <Progress value={c.score} className="h-1.5" />
              <p className="text-[11px] leading-snug text-muted-foreground/80">{c.detail}</p>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
            <span>Grade history</span>
            <Sparkline values={gradeSeries} width={120} height={28} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
        <Metric
          label="$STONKBROKER price"
          value={usd(metrics.priceUsd)}
          sub={`${pct(metrics.priceChange24hPct)} 24h · mcap ${usd(metrics.marketCapUsd)}`}
          tone={metrics.priceChange24hPct >= 0 ? "up" : "down"}
          spark={priceSeries}
        />
        <Metric
          label="Protocol revenue 24h"
          value={usd(metrics.protocolRevenue24hUsd)}
          sub={`7d avg ${usd(metrics.protocolRevenue7dUsd / 7)} · fees ${usd(metrics.protocolFees24hUsd)}`}
          tone={metrics.protocolRevenue24hUsd >= metrics.protocolRevenue7dUsd / 7 ? "up" : "down"}
        />
        <Metric
          label="Protocol volume 24h"
          value={usd(metrics.protocolVolume24hUsd)}
          sub={`7d avg ${usd(metrics.protocolVolume7dUsd / 7)} · token DEX vol ${usd(metrics.tokenDexVolume24hUsd)}`}
          tone={metrics.protocolVolume24hUsd >= metrics.protocolVolume7dUsd / 7 ? "up" : "down"}
        />
        <Metric
          label="Liquidity & TVL"
          value={usd(metrics.liquidityUsd)}
          sub={`${metrics.pairCount} DEX pairs · TVL ${usd(metrics.tvlUsd)}`}
          tone="neutral"
        />

        <Card className="sm:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Scout brief</CardTitle>
              <Badge variant="outline" className="font-mono text-[10px]">
                data: {metrics.source} · {ago(metrics.ts)}
              </Badge>
            </div>
            <CardDescription>{brief?.headline ?? "No brief yet."}</CardDescription>
          </CardHeader>
          {brief && (
            <CardContent>
              <ul className="space-y-1.5 text-sm">
                {brief.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-emerald-400/70" />
                    <span className="text-foreground/90">{b}</span>
                  </li>
                ))}
              </ul>
              {metrics.warnings.length > 0 && (
                <p className="mt-3 text-xs text-amber-400/90">{metrics.warnings.join(" · ")}</p>
              )}
            </CardContent>
          )}
        </Card>

        <Card className="sm:col-span-2">
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <ShieldCheck className="size-4 text-emerald-400" />
            <p className="flex-1 text-sm text-muted-foreground">
              <span className="text-foreground">{pending}</span> drafts and{" "}
              <span className="text-foreground">{pendingProposals}</span> strategy proposals are waiting
              for review. Nothing is published or adopted without an operator decision.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => onNavigate("queue")}>
                Review drafts <ArrowRight className="size-3.5" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => onNavigate("evolution")}>
                Review proposals <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
  spark,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "up" | "down" | "neutral";
  spark?: number[];
}) {
  const toneClass =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-foreground";
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={`font-mono text-2xl ${toneClass}`}>{value}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-3">
        <p className="text-xs text-muted-foreground">{sub}</p>
        {spark && spark.length > 1 && (
          <Sparkline
            values={spark}
            width={90}
            height={24}
            className={tone === "down" ? "stroke-rose-400" : "stroke-emerald-400"}
          />
        )}
      </CardContent>
    </Card>
  );
}
