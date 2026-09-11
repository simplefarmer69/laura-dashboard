"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  Bot,
  GitBranch,
  Inbox,
  LineChart as LineChartIcon,
  MessageCircle,
  Play,
  Radio,
  RefreshCw,
  Rocket,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { postJson, useSwarmState, type LinkStatus } from "@/components/console/use-swarm-state";
import { VIEWER_MODE, ViewerBanner, ViewerShield, describeHost } from "@/components/console/viewer";
import { Overview } from "@/components/console/overview";
import { ReviewQueue } from "@/components/console/queue";
import { Evolution } from "@/components/console/evolution";
import { AgentsPanel } from "@/components/console/agents";
import { RunsPanel } from "@/components/console/runs";
import { SettingsPanel } from "@/components/console/settings";
import { ActivityFeed } from "@/components/console/activity";
import { Growth } from "@/components/console/growth";
import { Launchpad } from "@/components/console/launchpad";
import { ChatPanel } from "@/components/console/chat";
import { CafeBar } from "@/components/console/forum";
import { pct, usd } from "@/components/console/format";
import type { CycleRun } from "@/lib/types";

const TAB_CLASS =
  "sb-ticker text-[11px] tracking-[0.08em] after:bg-primary dark:data-active:text-primary";

export function Console() {
  const { state, link, loading, refresh } = useSwarmState();
  const [tab, setTab] = useState("overview");
  const [starting, setStarting] = useState(false);

  const pendingDrafts = state?.drafts.filter((d) => d.status === "pending").length ?? 0;
  const pendingProposals = state?.proposals.filter((p) => p.status === "pending").length ?? 0;
  const pendingLaunches =
    state?.launches.filter((l) => l.status === "pending" || l.status === "approved").length ?? 0;
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
            {/* LAURA's sentinel mark — served as crisp SVG from the deterministic generator */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/api/laura/logo"
              alt="LAURA sentinel mark"
              width={40}
              height={40}
              className="size-10 shrink-0 border border-primary/40 bg-black/60 shadow-[0_0_16px_var(--sb-glow)]"
            />
            <div>
              <h1 className="sb-ticker text-sm font-semibold leading-tight tracking-[0.18em] text-primary sb-glow-text">
                LAURA
              </h1>
              <p className="text-xs font-medium tracking-wide text-primary/80">
                Layered Autonomous Unified Reasoning Agents
              </p>
              <p className="text-xs text-muted-foreground">
                {state?.settings.projectName ?? "StonkBrokers"} growth swarm · Robinhood Chain · by Clutch Markets
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {state?.runtime.host && !VIEWER_MODE && (
              <Badge
                variant="outline"
                className="hidden font-mono text-[10px] lg:inline-flex"
                title={state.runtime.host.builtAt ? `built ${state.runtime.host.builtAt}` : undefined}
              >
                {describeHost(state.runtime.host)}
              </Badge>
            )}
            {state && (
              <Badge variant="outline" className="hidden font-mono text-[10px] md:inline-flex">
                LLM {state.runtime.llmProvider === "mock" ? "fallback (no key)" : state.runtime.llmModel}
              </Badge>
            )}
            {state?.runtime.autopilot && !cycleRunning && (
              <Badge variant="outline" className="hidden text-[10px] text-[var(--sb-green)] sm:inline-flex">
                <Radio className="size-3" /> autopilot
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
            <Button
              size="sm"
              onClick={() => void startCycle()}
              disabled={cycleRunning || VIEWER_MODE}
              title={VIEWER_MODE ? "View-only. Cycles run from the operator's console." : undefined}
            >
              <Play className="size-3.5" /> Run cycle
            </Button>
            {/* StonkBrokers brand mark */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/stonkbrokers-logo.png"
              alt="StonkBrokers"
              width={36}
              height={36}
              className="size-9 shrink-0 border border-primary/40"
            />
          </div>
        </div>
        <div className="border-t border-border/60 bg-black/40">
          <div className="mx-auto flex h-8 w-full max-w-7xl items-center gap-6 overflow-x-auto px-4 sb-ticker text-[11px] whitespace-nowrap sm:px-6">
            {latest ? (
              <>
                <Tick label="$STONKBROKER" value={usd(latest.priceUsd)} />
                <Tick
                  label="24h"
                  value={`${latest.priceChange24hPct >= 0 ? "▲" : "▼"} ${pct(latest.priceChange24hPct)}`}
                  tone={latest.priceChange24hPct >= 0 ? "up" : "down"}
                />
                <Tick label="MCAP" value={usd(latest.marketCapUsd)} />
                <Tick label="REV 24H" value={usd(latest.protocolRevenue24hUsd)} />
                <Tick label="VOL 24H" value={usd(latest.protocolVolume24hUsd)} />
                {latest.onchain && (
                  <Tick label="CLOCK IN POT" value={`${latest.onchain.clockInPotEth.toFixed(3)} ETH`} />
                )}
                {grade && <Tick label="GRADE" value={`${grade.letter} ${grade.score.toFixed(1)}`} tone="accent" />}
                {state && (
                  <Tick
                    label="TO $1B"
                    value={Number.isFinite(state.mission.multipleToTarget) ? `${state.mission.multipleToTarget.toFixed(1)}x` : "—"}
                  />
                )}
                <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                  <span className={`size-1.5 rounded-full ${latest.source === "live" ? "bg-[var(--sb-green)] sb-pulse" : "bg-[var(--sb-gold)]"}`} />
                  data {latest.source} · {new Date(latest.ts).toUTCString().slice(17, 25)} UTC
                </span>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">telemetry: awaiting first snapshot</span>
                <span className="ml-auto text-muted-foreground">
                  <UtcClock /> UTC
                </span>
              </>
            )}
          </div>
        </div>
        {VIEWER_MODE && (
          <ViewerBanner publishedAt={state?.viewer?.publishedAt ?? null} host={state?.runtime.host ?? null} />
        )}
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {link.message && state && (
          <MaintenanceNotice link={link} loading={loading} onRetry={() => void refresh()} compact />
        )}
        {!state && loading && !link.message && <ConsoleSkeleton />}
        {!state && link.message && <MaintenanceNotice link={link} loading={loading} onRetry={() => void refresh()} />}
        {state && (
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
            <TabsList variant="line" className="w-full justify-start overflow-x-auto">
              <TabsTrigger className={TAB_CLASS} value="overview">
                <Activity /> Overview
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="activity">
                <Radio /> Activity
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="growth">
                <LineChartIcon /> Growth
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="chat">
                <MessageCircle /> The Cafe Bar
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="queue">
                <Inbox /> Review queue
                {pendingDrafts > 0 && (
                  <Badge className="ml-1 h-4 bg-primary/15 px-1.5 font-mono text-[10px] text-primary">
                    {pendingDrafts}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="launchpad">
                <Rocket /> Launchpad
                {pendingLaunches > 0 && (
                  <Badge className="ml-1 h-4 bg-primary/15 px-1.5 font-mono text-[10px] text-primary">
                    {pendingLaunches}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="evolution">
                <GitBranch /> Evolution
                {pendingProposals > 0 && (
                  <Badge className="ml-1 h-4 bg-primary/15 px-1.5 font-mono text-[10px] text-primary">
                    {pendingProposals}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="agents">
                <Bot /> Agents
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="runs">
                <Play /> Runs
              </TabsTrigger>
              <TabsTrigger className={TAB_CLASS} value="settings">
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
            <TabsContent value="chat">
              <div className="space-y-4">
                <CafeBar state={state} refresh={refresh} />
                <ViewerShield>
                  <ChatPanel />
                </ViewerShield>
              </div>
            </TabsContent>
            <TabsContent value="queue">
              <ViewerShield>
                <ReviewQueue state={state} refresh={refresh} />
              </ViewerShield>
            </TabsContent>
            <TabsContent value="launchpad">
              <ViewerShield>
                <Launchpad state={state} refresh={refresh} />
              </ViewerShield>
            </TabsContent>
            <TabsContent value="evolution">
              <ViewerShield>
                <Evolution state={state} refresh={refresh} />
              </ViewerShield>
            </TabsContent>
            <TabsContent value="agents">
              <ViewerShield>
                <AgentsPanel state={state} refresh={refresh} />
              </ViewerShield>
            </TabsContent>
            <TabsContent value="runs">
              <RunsPanel state={state} />
            </TabsContent>
            <TabsContent value="settings">
              <ViewerShield>
                <SettingsPanel state={state} refresh={refresh} />
              </ViewerShield>
            </TabsContent>
          </Tabs>
        )}
      </main>
      <footer className="border-t border-border/60 px-4 py-3 text-center sb-ticker text-[10px] text-muted-foreground/80">
        LAURA operates under the swarm charter · drafts are reviewed before publishing · rewards are contract distributions, not dividends
      </footer>
    </div>
  );
}

/** Structured loading state: the exact shell the data will occupy, one light sweep. */
/**
 * Maintenance state instead of exception text. Compact: a strip above the
 * last-known data (still shown, timestamped). Full: the card visitors see when
 * nothing has loaded yet. Both count down to the automatic retry.
 */
function MaintenanceNotice({
  link,
  loading,
  onRetry,
  compact = false,
}: {
  link: LinkStatus;
  loading: boolean;
  onRetry: () => void;
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const retryIn = link.nextRetryAt ? Math.max(0, Math.ceil((link.nextRetryAt - now) / 1000)) : null;
  const lastGood = link.lastGoodAt ? new Date(link.lastGoodAt).toUTCString().slice(17, 25) : null;
  if (compact) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3 border border-[var(--sb-gold)]/40 border-l-2 border-l-[var(--sb-gold)] bg-[var(--sb-gold)]/10 px-3 py-2 text-sm">
        <span className="sb-ticker text-[10px] text-[var(--sb-gold)]">maintenance</span>
        <span className="min-w-0 flex-1 text-foreground/90">
          {link.message}
          {lastGood && <span className="text-muted-foreground"> Showing data from {lastGood} UTC.</span>}
        </span>
        <span className="sb-ticker text-[10px] text-muted-foreground">
          {loading ? "reconnecting…" : retryIn !== null ? `retry in ${retryIn}s` : ""}
        </span>
        <Button size="sm" variant="outline" disabled={loading} onClick={onRetry}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Retry now
        </Button>
      </div>
    );
  }
  return (
    <div className="mx-auto mt-10 max-w-xl border border-[var(--sb-gold)]/40 bg-black/50 p-6 text-center shadow-[0_0_24px_rgba(0,0,0,0.4)]">
      <p className="sb-ticker text-[10px] tracking-[0.2em] text-[var(--sb-gold)]">MAINTENANCE</p>
      <h2 className="mt-2 text-lg font-semibold text-primary sb-glow-text">LAURA is between ticks</h2>
      <p className="mt-2 text-sm text-foreground/85">{link.message}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        The swarm, its launches and its treasury rules run on LAURA&apos;s host, not in this page — nothing stops
        while the console is unreachable.
      </p>
      <div className="mt-4 flex items-center justify-center gap-3">
        <span className="sb-ticker text-[10px] text-muted-foreground">
          {loading ? "reconnecting…" : retryIn !== null ? `automatic retry in ${retryIn}s` : ""}
        </span>
        <Button size="sm" variant="outline" disabled={loading} onClick={onRetry}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Retry now
        </Button>
      </div>
    </div>
  );
}

function ConsoleSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="flex gap-4 border-b border-border/60 pb-2">
        {["w-20", "w-16", "w-16", "w-12", "w-24", "w-20", "w-20", "w-14", "w-12", "w-16"].map((w, i) => (
          <div key={i} className={`h-4 ${w} bg-muted/40 ${i === 0 ? "bg-primary/20" : ""}`} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="sb-skeleton h-80 lg:col-span-1" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-2">
          <div className="sb-skeleton h-28" />
          <div className="sb-skeleton h-28" />
          <div className="sb-skeleton h-28" />
          <div className="sb-skeleton h-28" />
          <div className="sb-skeleton h-40 sm:col-span-2" />
        </div>
      </div>
      <p className="sb-ticker text-center text-[10px] text-muted-foreground">reading swarm state…</p>
    </div>
  );
}

/** Client-only ticking clock; renders a placeholder until mounted so SSR markup matches. */
function UtcClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  return <span>{now === null ? "—" : new Date(now).toUTCString().slice(17, 25)}</span>;
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
