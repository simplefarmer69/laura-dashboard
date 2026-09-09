"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, GitCommitHorizontal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { patchJson, type ConsoleState } from "@/components/console/use-swarm-state";
import { ago, when } from "@/components/console/format";
import type { StrategyProposal } from "@/lib/types";

export function Evolution({ state, refresh }: { state: ConsoleState; refresh: () => Promise<void> }) {
  const pending = useMemo(
    () => state.proposals.filter((p) => p.status === "pending").sort((a, b) => b.createdAt - a.createdAt),
    [state.proposals],
  );
  const decided = useMemo(
    () => state.proposals.filter((p) => p.status !== "pending").sort((a, b) => (b.reviewedAt ?? 0) - (a.reviewedAt ?? 0)),
    [state.proposals],
  );
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const lineage = state.agents
    .flatMap((a) => a.history.map((h) => ({ agent: a.name, ...h })))
    .sort((a, b) => b.adoptedAt - a.adoptedAt)
    .slice(0, 12);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">
            Pending proposals <span className="font-mono text-muted-foreground">{pending.length}</span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Auto-apply is {state.settings.autoApplyStrategyProposals ? "on" : "off"} (Settings)
          </p>
        </div>
        {pending.length === 0 && (
          <Card className="border-dashed">
            <CardHeader>
              <CardTitle className="text-base">No proposals waiting</CardTitle>
              <CardDescription>
                The coach proposes strategy revisions after each cycle for the agents whose grade lever or
                approval rate is weakest. Approving one bumps that agent&apos;s strategy version.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        {pending.map((p) => (
          <ProposalCard key={p.id} proposal={p} agentName={agentName(p.agentId)} refresh={refresh} />
        ))}

        {decided.length > 0 && (
          <div className="space-y-2 pt-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Decided</h3>
            {decided.slice(0, 10).map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs"
              >
                <Badge variant={p.status === "approved" ? "default" : "destructive"} className="capitalize">
                  {p.status}
                </Badge>
                <span className="font-medium">{agentName(p.agentId)}</span>
                <span className="text-muted-foreground">v{p.fromVersion} → v{p.fromVersion + 1}</span>
                {p.autoApplied && <Badge variant="outline">auto</Badge>}
                <span className="ml-auto text-muted-foreground">{when(p.reviewedAt)}</span>
                <p className="w-full text-muted-foreground">{p.rationale}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitCommitHorizontal className="size-4" /> Strategy lineage
          </CardTitle>
          <CardDescription>Every superseded strategy version is kept for rollback.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {lineage.length === 0 && (
            <p className="text-xs text-muted-foreground">All agents are on their v1 strategy.</p>
          )}
          {lineage.map((h, i) => (
            <div key={i} className="border-l-2 border-border pl-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">{h.agent}</span>
                <span className="font-mono text-muted-foreground">v{h.version}</span>
                <span className="ml-auto text-muted-foreground">{ago(h.adoptedAt)}</span>
              </div>
              <p className="text-muted-foreground">{h.reason}</p>
              {h.gradeAtAdoption !== null && h.gradeAtRetirement !== null && (
                <p className="font-mono text-[10px] text-muted-foreground">
                  grade {h.gradeAtAdoption.toFixed(1)} → {h.gradeAtRetirement.toFixed(1)} while live
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ProposalCard({
  proposal,
  agentName,
  refresh,
}: {
  proposal: StrategyProposal;
  agentName: string;
  refresh: () => Promise<void>;
}) {
  const [text, setText] = useState(proposal.proposedStrategy);
  const [busy, setBusy] = useState(false);

  async function decide(status: "approved" | "rejected") {
    setBusy(true);
    try {
      await patchJson(`/api/proposals/${proposal.id}`, {
        status,
        proposedStrategy: status === "approved" && text !== proposal.proposedStrategy ? text : undefined,
      });
      toast.success(status === "approved" ? `${agentName} moved to v${proposal.fromVersion + 1}` : "Proposal rejected");
      await refresh();
    } catch (err) {
      toast.error("Update failed", { description: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{agentName}</Badge>
          <span className="font-mono text-xs text-muted-foreground">
            v{proposal.fromVersion} → v{proposal.fromVersion + 1}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{ago(proposal.createdAt)}</span>
        </div>
        <CardTitle className="text-sm leading-snug">{proposal.rationale}</CardTitle>
        <CardDescription className="text-xs">
          Evidence: {proposal.evidence.join(" · ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Current</p>
          <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap">
            {proposal.currentStrategy}
          </pre>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-primary uppercase tracking-wide">Proposed (editable)</p>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="max-h-64 min-h-40 text-xs leading-relaxed"
          />
        </div>
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide("rejected")}>
            <X className="size-3.5" /> Reject
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void decide("approved")}>
            <Check className="size-3.5" /> Adopt strategy
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
