"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, when } from "@/components/console/format";
import type { ConsoleState } from "@/components/console/use-swarm-state";
import type { SwarmEvent, SwarmEventKind } from "@/lib/types";

type Group = "all" | "agents" | "operator" | "grader" | "evolution";

const GROUPS: { key: Group; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "agents", label: "Agent output" },
  { key: "evolution", label: "Evolution" },
  { key: "grader", label: "Grader & mission" },
  { key: "operator", label: "Operator" },
];

function groupOf(kind: SwarmEventKind): Exclude<Group, "all"> {
  switch (kind) {
    case "brief.created":
    case "draft.created":
    case "launch.proposed":
    case "cycle.started":
    case "cycle.finished":
    case "swarm.health":
    case "error":
      return "agents";
    case "proposal.created":
    case "proposal.adopted":
    case "lesson.learned":
    case "note.recorded":
    case "novelty.rejected":
    case "critic.vetoed":
    case "strategy.edited":
    case "tuner.adjusted":
    case "skill.updated":
      return "evolution";
    case "grade.stamped":
    case "milestone.reached":
    case "earnings.accrued":
    case "earnings.claimed":
      return "grader";
    case "draft.approved":
    case "draft.rejected":
    case "draft.published":
    case "proposal.rejected":
    case "agent.paused":
    case "agent.resumed":
    case "launch.approved":
    case "launch.rejected":
    case "launch.deployed":
    case "launch.armed":
    case "launch.verified":
    case "launch.failed":
      return "operator";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function kindTone(kind: SwarmEventKind): string {
  switch (kind) {
    case "milestone.reached":
    case "earnings.accrued":
    case "earnings.claimed":
      return "bg-[var(--sb-gold)]/20 text-[var(--sb-gold)]";
    case "grade.stamped":
      return "bg-primary/15 text-primary";
    case "lesson.learned":
    case "note.recorded":
    case "proposal.adopted":
    case "strategy.edited":
    case "tuner.adjusted":
    case "skill.updated":
      return "bg-[var(--sb-green)]/15 text-[var(--sb-green)]";
    case "draft.approved":
    case "draft.published":
    case "launch.approved":
    case "launch.deployed":
    case "launch.armed":
    case "launch.verified":
      return "bg-[var(--sb-green)]/15 text-[var(--sb-green)]";
    case "draft.rejected":
    case "proposal.rejected":
    case "launch.rejected":
    case "launch.failed":
    case "novelty.rejected":
    case "critic.vetoed":
    case "swarm.health":
    case "error":
      return "bg-destructive/15 text-destructive";
    case "draft.created":
    case "brief.created":
    case "proposal.created":
    case "launch.proposed":
      return "bg-secondary text-foreground";
    case "cycle.started":
    case "cycle.finished":
    case "agent.paused":
    case "agent.resumed":
      return "bg-muted text-muted-foreground";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function ActivityFeed({ state }: { state: ConsoleState }) {
  const [group, setGroup] = useState<Group>("all");
  const events = useMemo(
    () =>
      [...state.events]
        .filter((e) => group === "all" || groupOf(e.kind) === group)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 300),
    [state.events, group],
  );
  const agentName = (e: SwarmEvent) => state.agents.find((a) => a.id === e.agentId)?.name ?? e.agentId;

  const byDay = useMemo(() => {
    const map = new Map<string, SwarmEvent[]>();
    for (const e of events) {
      const day = new Date(e.ts).toISOString().slice(0, 10);
      map.set(day, [...(map.get(day) ?? []), e]);
    }
    return [...map.entries()];
  }, [events]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {GROUPS.map((g) => (
          <Button key={g.key} size="sm" variant={group === g.key ? "default" : "outline"} onClick={() => setGroup(g.key)}>
            {g.label}
          </Button>
        ))}
        <span className="ml-auto sb-ticker text-[11px] text-muted-foreground">
          {state.events.length} actions logged
        </span>
      </div>

      {events.length === 0 && (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">No actions yet</CardTitle>
            <CardDescription>Every grader stamp, draft, lesson, proposal and operator decision will appear here as LAURA works.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {byDay.map(([day, list]) => (
        <Card key={day}>
          <CardHeader className="pb-2">
            <CardTitle className="sb-ticker text-xs text-muted-foreground">{day} UTC · {list.length} actions</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative space-y-3 border-l border-border/60 pl-4">
              {list.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 size-2 bg-primary" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={`${kindTone(e.kind)} font-mono text-[10px]`}>{e.kind}</Badge>
                    <span className="text-xs text-muted-foreground">{agentName(e)}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground" title={when(e.ts)}>
                      {ago(e.ts)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-snug">{e.title}</p>
                  {e.detail && <p className="text-xs leading-snug text-muted-foreground">{e.detail}</p>}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
