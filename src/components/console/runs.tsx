"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dur, when } from "@/components/console/format";
import type { ConsoleState } from "@/components/console/use-swarm-state";
import type { RunStepStatus } from "@/lib/types";

function stepTone(s: RunStepStatus): string {
  switch (s) {
    case "ok":
      return "text-[var(--sb-green)]";
    case "error":
      return "text-destructive";
    case "skipped":
      return "text-muted-foreground";
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

export function RunsPanel({ state }: { state: ConsoleState }) {
  const runs = [...state.runs].sort((a, b) => b.startedAt - a.startedAt);
  if (runs.length === 0) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">No runs yet</CardTitle>
          <CardDescription>Each cycle is logged step by step here, including fallbacks and errors.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {runs.slice(0, 20).map((r) => (
        <Card key={r.id}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="font-mono text-sm">{r.id}</CardTitle>
              <Badge variant="outline">{r.trigger}</Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                {r.llmProvider}
              </Badge>
              {r.error && <Badge variant="destructive">failed</Badge>}
              {!r.finishedAt && <Badge className="bg-primary/15 text-primary">running</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">
                {when(r.startedAt)}
                {r.finishedAt ? ` · ${dur(r.finishedAt - r.startedAt)}` : ""}
              </span>
            </div>
            <CardDescription>
              {r.draftsCreated} drafts · {r.proposalsCreated} proposals
              {r.error ? ` · ${r.error}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Agent</TableHead>
                  <TableHead className="w-40">Step</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead className="w-16 text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.steps.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">{s.agentId}</TableCell>
                    <TableCell className={`text-xs ${stepTone(s.status)}`}>{s.label}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.summary}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{dur(s.durationMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
