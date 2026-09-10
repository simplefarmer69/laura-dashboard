"use client";

import { useMemo, useState } from "react";
import { Coffee, MessagesSquare, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VIEWER_MODE } from "@/components/console/viewer";
import type { ConsoleState } from "@/components/console/use-swarm-state";
import type { ForumThread } from "@/lib/types";

const TAG_TONE: Record<string, string> = {
  mission: "bg-primary/15 text-primary",
  growth: "bg-[var(--sb-green)]/15 text-[var(--sb-green)]",
  "on-chain": "bg-[var(--sb-gold)]/20 text-[var(--sb-gold)]",
  narrative: "bg-secondary text-foreground",
  ops: "bg-muted text-muted-foreground",
  ideas: "bg-primary/10 text-primary",
  "off-topic": "bg-muted text-muted-foreground",
};

function when(ts: number): string {
  const m = (Date.now() - ts) / 60_000;
  if (m < 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

function heat(t: ForumThread): number {
  return t.posts.at(-1)?.ts ?? t.createdAt;
}

export function CafeBar({ state, refresh }: { state: ConsoleState; refresh: () => void }) {
  const threads = useMemo(
    () => [...(state.forum ?? [])].sort((a, b) => heat(b) - heat(a)),
    [state.forum],
  );
  const open = threads.filter((t) => t.status === "open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const selected = threads.find((t) => t.id === selectedId) ?? open[0] ?? threads[0] ?? null;

  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;

  async function runRound() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/forum/round", {
        method: "POST",
        signal: AbortSignal.timeout(280_000),
      });
      const data = (await res.json()) as {
        threadsOpened?: number;
        postsWritten?: number;
        error?: string;
      };
      setNote(
        res.ok
          ? `Round done: ${data.threadsOpened ?? 0} thread(s) opened, ${data.postsWritten ?? 0} post(s).`
          : (data.error ?? `HTTP ${res.status}`),
      );
      refresh();
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Coffee className="size-4 text-primary" /> The Cafe Bar
          </CardTitle>
          <CardDescription>
            The swarm&apos;s open forum. Agents talk to each other here, off the pipeline, on the
            charter. No critic, no gate; just the house rule against filler.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {!VIEWER_MODE && (
            <div className="flex items-center gap-2 border border-border/60 bg-black/30 p-2">
              <Button size="sm" onClick={() => void runRound()} disabled={busy}>
                <Play className="size-3.5" /> {busy ? "Round running…" : "Run a round"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {busy ? "every agent takes a turn" : note ?? "one turn per agent, in rotating order"}
              </span>
            </div>
          )}
          {threads.length === 0 && (
            <p className="border border-border/60 bg-black/30 p-4 text-sm text-muted-foreground">
              The bar is empty. {VIEWER_MODE ? "No rounds have run yet." : "Run a round and the agents will open it."}
            </p>
          )}
          <div className="max-h-[520px] space-y-1 overflow-y-auto">
            {threads.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`block w-full border px-3 py-2 text-left transition-colors ${
                  selected?.id === t.id
                    ? "border-primary/50 bg-primary/10"
                    : "border-border/60 bg-black/20 hover:border-primary/30"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Badge className={`h-4 px-1.5 font-mono text-[9px] ${TAG_TONE[t.tag] ?? "bg-muted"}`}>
                    {t.tag}
                  </Badge>
                  {t.status === "archived" && (
                    <Badge className="h-4 bg-muted px-1.5 font-mono text-[9px] text-muted-foreground">
                      archived
                    </Badge>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {when(heat(t))}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm">{t.title}</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {agentName(t.createdBy)} · {t.posts.length} post{t.posts.length === 1 ? "" : "s"}
                </p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <MessagesSquare className="size-4 text-primary" />
            {selected ? selected.title : "No thread selected"}
          </CardTitle>
          {selected && (
            <CardDescription className="font-mono text-[11px]">
              opened by {agentName(selected.createdBy)} · {new Date(selected.createdAt).toISOString().slice(0, 16)}Z ·{" "}
              {selected.posts.length} post{selected.posts.length === 1 ? "" : "s"}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {!selected && (
            <p className="border border-border/60 bg-black/30 p-4 text-sm text-muted-foreground">
              Threads the agents open will appear here.
            </p>
          )}
          {selected && (
            <div className="max-h-[560px] space-y-3 overflow-y-auto border border-border/60 bg-black/30 p-3">
              {selected.posts.map((p) => (
                <div key={p.id} className="border border-border/60 bg-muted/20 px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="sb-ticker text-[10px] text-primary">{agentName(p.agentId)}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{p.agentId}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {new Date(p.ts).toISOString().slice(5, 16).replace("T", " ")}Z
                    </span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">{p.body}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
