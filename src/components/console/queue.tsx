"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Pencil, Send, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { patchJson, type ConsoleState } from "@/components/console/use-swarm-state";
import { ago } from "@/components/console/format";
import type { Draft, DraftStatus } from "@/lib/types";

const FILTERS: { key: DraftStatus | "all"; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "published", label: "Published" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

async function postJsonAction<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "POST" });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function ReviewQueue({ state, refresh }: { state: ConsoleState; refresh: () => Promise<void> }) {
  const [filter, setFilter] = useState<DraftStatus | "all">("pending");
  const drafts = useMemo(
    () =>
      [...state.drafts]
        .filter((d) => filter === "all" || d.status === filter)
        .sort((a, b) => b.createdAt - a.createdAt),
    [state.drafts, filter],
  );
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const count =
            f.key === "all" ? state.drafts.length : state.drafts.filter((d) => d.status === f.key).length;
          return (
            <Button
              key={f.key}
              size="sm"
              variant={filter === f.key ? "default" : "outline"}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="font-mono text-xs opacity-70">{count}</span>
            </Button>
          );
        })}
        {state.settings.autoApproveProposals && (
          <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">FULL AUTONOMY</Badge>
        )}
        <p className="ml-auto text-xs text-muted-foreground">
          {state.settings.autoApproveProposals
            ? "New drafts approve automatically; you can still reject or edit, and publishing stays a separate step."
            : "Approve to mark ready, then mark Published once you post it on the channel yourself."}
        </p>
      </div>

      {drafts.length === 0 && (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">Nothing here</CardTitle>
            <CardDescription>
              {filter === "pending"
                ? "The queue is clear. Run a cycle to generate new drafts."
                : `No ${filter} drafts yet.`}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            agentName={agentName(d.agentId)}
            xReady={state.runtime.x.ready}
            refresh={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function statusVariant(s: DraftStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (s) {
    case "approved":
      return "default";
    case "published":
      return "secondary";
    case "rejected":
      return "destructive";
    case "pending":
      return "outline";
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

function DraftCard({
  draft,
  agentName,
  xReady,
  refresh,
}: {
  draft: Draft;
  agentName: string;
  xReady: boolean;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const [note, setNote] = useState(draft.reviewerNote ?? "");
  const [busy, setBusy] = useState(false);

  async function decide(status: DraftStatus) {
    setBusy(true);
    try {
      await patchJson(`/api/drafts/${draft.id}`, {
        status,
        reviewerNote: note || undefined,
        body: editing && body !== draft.body ? body : undefined,
      });
      setEditing(false);
      toast.success(`Draft ${status}`);
      await refresh();
    } catch (err) {
      toast.error("Update failed", { description: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(body);
    toast("Copied to clipboard");
  }

  const isXDraft = /^(x|twitter)$/i.test(draft.channel.trim());

  async function publishX() {
    setBusy(true);
    try {
      const out = await postJsonAction<{ url: string; tweets: number }>(`/api/drafts/${draft.id}/publish`);
      toast.success(`Posted to X (${out.tweets} post${out.tweets > 1 ? "s" : ""})`, { description: out.url });
      await refresh();
    } catch (err) {
      toast.error("X publish failed", { description: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(draft.status)} className="capitalize">
            {draft.status}
          </Badge>
          <Badge variant="outline" className="font-mono text-[10px]">
            {draft.kind} · {draft.channel}
          </Badge>
          <span className="ml-auto text-xs text-muted-foreground">
            {agentName} · {ago(draft.createdAt)}
          </span>
        </div>
        <CardTitle className="text-base leading-snug">{draft.title}</CardTitle>
        <CardDescription className="text-xs">{draft.rationale}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {editing ? (
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-64 font-mono text-xs"
          />
        ) : (
          <pre className="max-h-72 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">
            {body}
          </pre>
        )}
        {draft.status === "pending" && (
          <Input
            placeholder="Reviewer note (fed back to the agent and the coach)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="text-xs"
          />
        )}
        {draft.status !== "pending" && draft.reviewerNote && (
          <p className="text-xs text-muted-foreground">Reviewer: {draft.reviewerNote}</p>
        )}
        {draft.publishedUrl && (
          <a
            href={draft.publishedUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary hover:underline"
          >
            View live post ↗
          </a>
        )}
        <div className="mt-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => void copy()}>
            <Copy className="size-3.5" /> Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            <Pencil className="size-3.5" /> {editing ? "Preview" : "Edit"}
          </Button>
          <div className="ml-auto flex gap-2">
            {draft.status === "pending" && (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide("rejected")}>
                  <X className="size-3.5" /> Reject
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void decide("approved")}>
                  <Check className="size-3.5" /> Approve
                </Button>
              </>
            )}
            {draft.status === "approved" && isXDraft && (
              <Button
                size="sm"
                disabled={busy || !xReady}
                onClick={() => void publishX()}
                title={xReady ? "Post via the X API" : "Add X_ACCESS_TOKEN + X_ACCESS_TOKEN_SECRET to enable"}
              >
                <Send className="size-3.5" /> {xReady ? "Publish to X" : "Publish to X (locked: access token)"}
              </Button>
            )}
            {draft.status === "approved" && (
              <Button size="sm" variant={isXDraft ? "outline" : "default"} disabled={busy} onClick={() => void decide("published")}>
                <Send className="size-3.5" /> Mark published
              </Button>
            )}
            {(draft.status === "rejected" || draft.status === "published") && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("pending")}>
                Reopen
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
