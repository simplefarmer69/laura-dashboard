"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Pause, Play, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { patchJson, type ConsoleState } from "@/components/console/use-swarm-state";
import { ago } from "@/components/console/format";
import { DEFAULT_AGENTS, SWARM_CHARTER } from "@/lib/swarm/roster";
import type { Agent, AgentStatus } from "@/lib/types";

/**
 * The roster is snapshot-driven: the VM publishes state.agents from its own
 * saved state, which can lag a roster extension in this repo. Merge any
 * DEFAULT_AGENTS the snapshot does not know yet so new agents appear in the
 * viewer immediately (the VM picks them up on its next deploy + loadState).
 */
function mergedRoster(agents: Agent[]): Agent[] {
  const known = new Set(agents.map((a) => a.id));
  return [...agents, ...DEFAULT_AGENTS.filter((a) => !known.has(a.id))];
}

function statusTone(s: AgentStatus): string {
  switch (s) {
    case "running":
      return "bg-primary/15 text-primary";
    case "error":
      return "bg-destructive/15 text-destructive";
    case "paused":
      return "bg-[var(--sb-gold)]/15 text-[var(--sb-gold)]";
    case "idle":
      return "bg-muted text-muted-foreground";
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

export function AgentsPanel({ state, refresh }: { state: ConsoleState; refresh: () => Promise<void> }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Swarm charter (immutable)</CardTitle>
          <CardDescription>
            Injected into every LAURA prompt. The coach can evolve per-agent strategy text but can never touch these rules.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-48 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap">
            {SWARM_CHARTER}
          </pre>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {mergedRoster(state.agents).map((a) => (
          <AgentCard key={a.id} agent={a} refresh={refresh} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent, refresh }: { agent: Agent; refresh: () => Promise<void> }) {
  const [strategy, setStrategy] = useState(agent.strategy);
  const [busy, setBusy] = useState(false);
  const dirty = strategy !== agent.strategy;

  async function save(patch: { strategy?: string; status?: "idle" | "paused" }) {
    setBusy(true);
    try {
      await patchJson(`/api/agents/${agent.id}`, patch);
      toast.success(patch.status ? `${agent.name} ${patch.status}` : `${agent.name} strategy saved as v${agent.strategyVersion + 1}`);
      await refresh();
    } catch (err) {
      toast.error("Update failed", { description: String(err) });
    } finally {
      setBusy(false);
    }
  }

  const approvalRate =
    agent.stats.approved + agent.stats.rejected > 0
      ? Math.round((agent.stats.approved / (agent.stats.approved + agent.stats.rejected)) * 100)
      : null;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{agent.name}</CardTitle>
          <Badge className={statusTone(agent.status)}>{agent.status}</Badge>
          <Badge variant="outline" className="font-mono text-[10px]">
            strategy v{agent.strategyVersion}
          </Badge>
          <span className="ml-auto text-xs text-muted-foreground">last run {ago(agent.lastRunAt)}</span>
        </div>
        <CardDescription>
          <span className="text-foreground/80">{agent.role}.</span> {agent.objective}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="grid grid-cols-4 gap-2 text-center">
          <Stat label="runs" value={agent.stats.runs} />
          <Stat label="drafts" value={agent.stats.drafts} />
          <Stat label="approved" value={agent.stats.approved} />
          <Stat label="approval" value={approvalRate === null ? "—" : `${approvalRate}%`} />
        </div>
        <Textarea
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          className="min-h-36 text-xs leading-relaxed"
        />
        {agent.lastError && <p className="text-xs text-destructive">{agent.lastError}</p>}
        <div className="mt-auto flex gap-2">
          {agent.status === "paused" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ status: "idle" })}>
              <Play className="size-3.5" /> Resume
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ status: "paused" })}>
              <Pause className="size-3.5" /> Pause
            </Button>
          )}
          <Button size="sm" className="ml-auto" disabled={busy || !dirty} onClick={() => void save({ strategy })}>
            <Save className="size-3.5" /> Save as v{agent.strategyVersion + 1}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 py-1.5">
      <div className="font-mono text-sm">{value}</div>
      <div className="sb-label">{label}</div>
    </div>
  );
}
