"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  Bot,
  GitBranch,
  Inbox,
  LineChart as LineChartIcon,
  Play,
  Radio,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { postJson, useSwarmState } from "@/components/console/use-swarm-state";
import { Overview } from "@/components/console/overview";
import { ReviewQueue } from "@/components/console/queue";
import { Evolution } from "@/components/console/evolution";
import { AgentsPanel } from "@/components/console/agents";
import { RunsPanel } from "@/components/console/runs";
import { SettingsPanel } from "@/components/console/settings";
import { ActivityFeed } from "@/components/console/activity";
import { Growth } from "@/components/console/growth";
import { pct, usd } from "@/components/console/format";
import type { CycleRun } from "@/lib/types";

export function Console() {
  const { state, error, loading, refresh } = useSwarmState();
  const [tab, setTab] = useState("overview");
  const [starting, setStarting] = useState(false);

  const pendingDrafts = state?.drafts.filter((d) => d.status === "pending").length ?? 0;
  const pendingProposals = state?.proposals.filter((p) => p.status === "pending").length ?? 0;
  const cycleRunning = starting || (state?.runtime.cycleRunning ?? false);
  const latest = state?.metricsHistory.at(-1) ?? null;
  const grade = state?.grades.at(-1) ?? null;

  async function startCycle() {
    setStarting(true);
    toast("Cycle started", { description: "Grader, scout, producers and coach are running." });
    void refresh();
    try {
      const run = await postJson<CycleRun>("/api/cycle");
      toast.success(`Cycle finished: ${run.draftsCreated} drafts, ${run.proposalsCreated} proposals`, {
        description: run.steps.find((s) => s.agentId === "grader")?.summary,
      });
    } catch (err) {
      toast.error("Cycle failed", { description: String(err) });
    } finally {
      setStarting(false);
      void refresh();
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-primary/30 bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center border border-primary bg-primary/10 font-mono text-sm font-bold text-primary sb-glow-text">
              L
            </div>
            <div>
              <h1 className="sb-ticker text-sm font-semibold leading-tight text-primary">LAURA</h1>
              <p className="text-xs text-muted-foreground">
                {state?.settings.projectName ?? "StonkBrokers"} growth swarm · Robinhood Chain · by Clutch Markets
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {state && (
              <Badge variant="outline" className="hidden font-mono text-[10px] md:inline-flex">
                LLM {state.runtime.llmProvider === "mock" ? "fallback (no key)" : state.runtime.llmModel}
              </Badge>
            )}
            {cycleRunning && (
              <Badge className="bg-primary/15 text-primary">
                <Radio className="size-3 sb-blink" /> cycle running
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button size="sm" onClick={() => void startCycle()} disabled={cycleRunning}>
              <Play className="size-3.5" /> Run cycle
            </Button>
          </div>
        </div>
        {latest && (
          <div className="border-t border-border/60 bg-black/40">
            <div className="mx-auto flex w-full max-w-7xl gap-6 overflow-x-auto px-4 py-1.5 sb-ticker text-[11px] whitespace-nowrap sm:px-6">
              <Tick label="$STONKBROKER" value={usd(latest.priceUsd)} />
              <Tick
                label="24h"
                value={pct(latest.priceChange24hPct)}
                tone={latest.priceChange24hPct >= 0 ? "up" : "down"}
              />
              <Tick label="MCAP" value={usd(latest.marketCapUsd)} />
              <Tick label="REV 24H" value={usd(latest.protocolRevenue24hUsd)} />
              <Tick label="VOL 24H" value={usd(latest.protocolVolume24hUsd)} />
              {latest.onchain && <Tick label="CLOCK IN POT" value={`${latest.onchain.clockInPotEth.toFixed(3)} ETH`} />}
              {grade && <Tick label="GRADE" value={`${grade.letter} ${grade.score.toFixed(1)}`} tone="accent" />}
              {state && (
                <Tick
                  label="TO $1B"
                  value={Number.isFinite(state.mission.multipleToTarget) ? `${state.mission.multipleToTarget.toFixed(1)}x` : "—"}
                />
              )}
              <span className="ml-auto text-muted-foreground">
                data {latest.source} · {new Date(latest.ts).toUTCString().slice(17, 25)} UTC
              </span>
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {error && (
          <div className="mb-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Could not reach the console API: {error}
          </div>
        )}
        {!state && loading && (
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse border border-border/60 bg-muted/30" />
            ))}
          </div>
        )}
        {state && (
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
            <TabsList variant="line" className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview">
                <Activity /> Overview
              </TabsTrigger>
              <TabsTrigger value="activity">
                <Radio /> Activity
              </TabsTrigger>
              <TabsTrigger value="growth">
                <LineChartIcon /> Growth
              </TabsTrigger>
              <TabsTrigger value="queue">
                <Inbox /> Review queue
                {pendingDrafts > 0 && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
                    {pendingDrafts}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="evolution">
                <GitBranch /> Evolution
                {pendingProposals > 0 && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
                    {pendingProposals}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="agents">
                <Bot /> Agents
              </TabsTrigger>
              <TabsTrigger value="runs">
                <Play /> Runs
              </TabsTrigger>
              <TabsTrigger value="settings">
                <Settings2 /> Settings
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <Overview state={state} onNavigate={setTab} />
            </TabsContent>
            <TabsContent value="activity">
              <ActivityFeed state={state} />
            </TabsContent>
            <TabsContent value="growth">
              <Growth state={state} />
            </TabsContent>
            <TabsContent value="queue">
              <ReviewQueue state={state} refresh={refresh} />
            </TabsContent>
            <TabsContent value="evolution">
              <Evolution state={state} refresh={refresh} />
            </TabsContent>
            <TabsContent value="agents">
              <AgentsPanel state={state} refresh={refresh} />
            </TabsContent>
            <TabsContent value="runs">
              <RunsPanel state={state} />
            </TabsContent>
            <TabsContent value="settings">
              <SettingsPanel state={state} refresh={refresh} />
            </TabsContent>
          </Tabs>
        )}
      </main>
      <footer className="border-t border-border/60 px-4 py-3 text-center sb-ticker text-[10px] text-muted-foreground">
        LAURA operates under the swarm charter · drafts are reviewed before publishing · rewards are contract distributions, not dividends
      </footer>
    </div>
  );
}

function Tick({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "up" | "down" | "neutral" | "accent" }) {
  const cls =
    tone === "up"
      ? "text-[var(--sb-green)]"
      : tone === "down"
        ? "text-destructive"
        : tone === "accent"
          ? "text-primary"
          : "text-foreground";
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cls}>{value}</span>
    </span>
  );
}
