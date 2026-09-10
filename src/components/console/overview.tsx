"use client";

import { ArrowRight, Crown, Radio, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Sparkline } from "@/components/console/sparkline";
import { ago, gradeTone, pct, usd } from "@/components/console/format";
import { kindTone } from "@/components/console/activity";
import {
  DefillamaPanel,
  EspnPanel,
  LauncherFeedPanel,
  LiveApiCalls,
  NftBuysPanel,
  PolymarketPanel,
  useFeeds,
} from "@/components/console/feeds";
import {
  NftTrendsPanel,
  SmartLpStudySection,
  TokenTapePanel,
  useIntelFeeds,
} from "@/components/console/laura-feeds";
import { FeeBreakdownPanel, useFeeBreakdown } from "@/components/console/fee-breakdown";
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
  const feeds = useFeeds();
  const intel = useIntelFeeds();
  const feeBreakdown = useFeeBreakdown();

  if (!grade || !metrics) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle>No cycle has run yet</CardTitle>
          <CardDescription>
            Press <span className="font-medium text-foreground">Run cycle</span> to pull live metrics from
            DexScreener, DefiLlama and the Robinhood Chain RPC, grade the day, and let LAURA&apos;s six agents
            produce their first brief, drafts, lessons and strategy proposals.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-1">
      <Card>
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

      <Card className="flex-1">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Radio className="size-3.5 text-[var(--sb-green)] sb-blink" /> Live actions
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={() => onNavigate("activity")}>
              Full log <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5">
            {[...state.events].sort((a, b) => b.ts - a.ts).slice(0, 12).map((e) => (
              <li key={e.id} className="flex items-center gap-2 text-xs">
                <Badge className={`${kindTone(e.kind)} h-4 px-1.5 font-mono text-[9px]`}>{e.kind}</Badge>
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{ago(e.ts)}</span>
              </li>
            ))}
            {state.events.length === 0 && <li className="text-xs text-muted-foreground">No actions yet.</li>}
          </ul>
        </CardContent>
      </Card>

      <LiveApiCalls calls={feeds.calls} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-2">
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
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary" />
                    <span className="text-foreground/90">{b}</span>
                  </li>
                ))}
              </ul>
              {metrics.warnings.length > 0 && (
                <p className="mt-3 text-xs text-[var(--sb-gold)]/90">{metrics.warnings.join(" · ")}</p>
              )}
            </CardContent>
          )}
        </Card>

        <Card className="sb-panel sm:col-span-2">
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            <Crown className="size-4 text-[var(--sb-gold)]" />
            <div className="min-w-0 flex-1">
              <p className="sb-ticker text-[11px] text-muted-foreground">Mission · $1B market cap → DAIO mandate</p>
              <p className="text-sm">
                <span className="sb-glow-text font-mono text-primary">{usd(state.mission.marketCapUsd)}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="font-mono">{Number.isFinite(state.mission.multipleToTarget) ? `${state.mission.multipleToTarget.toFixed(1)}x` : "—"}</span>
                <span className="text-muted-foreground"> to target · next {state.mission.next?.label.split(" ")[0] ?? "done"}</span>
              </p>
            </div>
            <div className="h-2 w-full bg-muted sm:w-48">
              <div className="h-full bg-primary" style={{ width: `${(state.mission.progress * 100).toFixed(2)}%` }} />
            </div>
            <Button size="sm" variant="outline" onClick={() => onNavigate("growth")}>
              Growth <ArrowRight className="size-3.5" />
            </Button>
          </CardContent>
        </Card>

        {metrics.onchain && (
          <Card className="sm:col-span-2">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="sb-ticker text-xs text-muted-foreground">On-chain · Robinhood Chain block {metrics.onchain.blockNumber.toLocaleString()}</CardTitle>
                <Badge variant="outline" className="font-mono text-[10px]">ETH {usd(metrics.onchain.ethPriceUsd, 0)}</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Chain label="Clock In pot" value={`${metrics.onchain.clockInPotEth.toFixed(3)} ETH`} sub={usd(metrics.onchain.clockInPotUsd)} />
              <Chain label="Brokers in circulation" value={metrics.onchain.brokersInCirculation.toLocaleString()} sub="of 4,444" />
              <Chain label="Brokers in Anvil vault" value={metrics.onchain.brokersInVault.toLocaleString()} sub="swap 666,666 $STONKBROKER" />
              <Chain label="Token supply" value={`${(metrics.onchain.tokenTotalSupply / 1e9).toFixed(4)}B`} sub="falls with activation burns" />
            </CardContent>
          </Card>
        )}

        <Card className="sm:col-span-2">
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <ShieldCheck className="size-4 text-[var(--sb-green)]" />
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

      <div className="lg:col-span-3">
        <DefillamaPanel data={feeds.defillama} />
      </div>

      <div className="lg:col-span-3">
        <FeeBreakdownPanel data={feeBreakdown} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-3 xl:grid-cols-4">
        <LauncherFeedPanel data={feeds.launcher} />
        <NftBuysPanel data={feeds.nftBuys} />
        <PolymarketPanel data={feeds.polymarket} />
        <EspnPanel data={feeds.espn} />
      </div>

      <div className="lg:col-span-3">
        <SmartLpStudySection data={intel.smartlp} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-3">
        <TokenTapePanel data={intel.tokens} />
        <NftTrendsPanel data={intel.nftTrends} buys={feeds.nftBuys} />
      </div>
    </div>
  );
}

function Chain({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border border-border/60 bg-muted/20 p-2.5">
      <p className="sb-label">{label}</p>
      <p className="font-mono text-base">{value}</p>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
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
    tone === "up" ? "text-[var(--sb-green)]" : tone === "down" ? "text-[var(--sb-neg)]" : "text-foreground";
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={`font-mono text-2xl ${toneClass}`}>
          {tone !== "neutral" && <span className="mr-1 text-sm">{tone === "up" ? "▲" : "▼"}</span>}
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-3">
        <p className="text-xs text-muted-foreground">{sub}</p>
        {spark && spark.length > 1 && (
          <Sparkline
            values={spark}
            width={90}
            height={24}
            className={tone === "down" ? "stroke-[var(--sb-neg)]" : "stroke-[var(--sb-green)]"}
          />
        )}
      </CardContent>
    </Card>
  );
}
