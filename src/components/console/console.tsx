"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Activity, Bot, GitBranch, Inbox, Play, RefreshCw, Settings2, Zap } from "lucide-react";
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
import type { CycleRun } from "@/lib/types";

export function Console() {
  const { state, error, loading, refresh } = useSwarmState();
  const [tab, setTab] = useState("overview");
  const [starting, setStarting] = useState(false);

  const pendingDrafts = state?.drafts.filter((d) => d.status === "pending").length ?? 0;
  const pendingProposals = state?.proposals.filter((p) => p.status === "pending").length ?? 0;
  const cycleRunning = starting || (state?.runtime.cycleRunning ?? false);

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
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
              <Zap className="size-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Stonk Swarm Console</h1>
              <p className="text-xs text-muted-foreground">
                {state?.settings.projectName ?? "StonkBrokers"} growth swarm · Robinhood Chain (4663)
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {state && (
              <Badge variant="outline" className="hidden font-mono sm:inline-flex">
                LLM: {state.runtime.llmProvider === "mock" ? "mock (no key)" : state.runtime.llmModel}
              </Badge>
            )}
            {cycleRunning && (
              <Badge className="bg-emerald-500/15 text-emerald-400">
                <Activity className="size-3 animate-pulse" /> cycle running
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
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {error && (
          <div className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            Could not reach the console API: {error}
          </div>
        )}
        {!state && loading && (
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl border border-border/60 bg-muted/30" />
            ))}
          </div>
        )}
        {state && (
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
            <TabsList variant="line" className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview">
                <Activity /> Overview
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
    </div>
  );
}
