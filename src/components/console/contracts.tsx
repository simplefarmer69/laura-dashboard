"use client";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Hammer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ago } from "@/components/console/format";
import type { ForgeProject, ForgeStatus } from "@/lib/types";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const GUIDE = "https://github.com/simplefarmer69/laura-dashboard/blob/main/docs/OWNERSHIP-MARKET.md";

function statusBadge(s: ForgeStatus) {
  switch (s) {
    case "pending":
      return <Badge variant="outline">designed</Badge>;
    case "approved":
      return <Badge variant="outline" className="text-[var(--sb-gold)]">queued to deploy</Badge>;
    case "deployed":
      return <Badge variant="outline" className="text-[var(--sb-gold)]">deployed · verifying</Badge>;
    case "verified":
      return <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">verified</Badge>;
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "rejected":
      return <Badge variant="secondary">rejected</Badge>;
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

function ProjectCard({ p }: { p: ForgeProject }) {
  const [open, setOpen] = useState(false);
  const explorer = p.explorerUrl ?? (p.contractAddress ? `${EXPLORER}/address/${p.contractAddress}` : null);
  return (
    <Card className={p.kind === "flagship" ? "border-primary/40" : undefined}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Hammer className="size-4 text-primary" />
            {p.title}
            <span className="font-mono text-xs text-muted-foreground">{p.contractName}</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            {p.kind === "flagship" && <Badge variant="secondary">flagship · audited in-repo</Badge>}
            {statusBadge(p.status)}
          </div>
        </div>
        <CardDescription className="text-xs">{p.blurb}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {p.contractAddress && (
          <p className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono">{p.contractAddress}</span>
            {explorer && (
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={explorer} target="_blank" rel="noreferrer">
                explorer <ExternalLink className="size-3" />
              </a>
            )}
            {p.txHash && (
              <a className="inline-flex items-center gap-1 text-muted-foreground hover:underline" href={`${EXPLORER}/tx/${p.txHash}`} target="_blank" rel="noreferrer">
                deploy tx <ExternalLink className="size-3" />
              </a>
            )}
          </p>
        )}
        <p className="text-muted-foreground">
          {p.deployedAt ? `deployed ${ago(p.deployedAt)}` : `designed ${ago(p.createdAt)}`}
          {p.verifiedAt ? ` · verified ${ago(p.verifiedAt)} via ${p.verifiedVia}` : ""}
          {p.deployCostEth !== null ? ` · gas ${p.deployCostEth.toFixed(6)} ETH` : ""}
          {p.compileAttempts > 1 ? ` · ${p.compileAttempts} compile rounds` : ""}
          {p.sourceAuthor ? ` · asked by @${p.sourceAuthor}` : ""}
        </p>
        {p.error && <p className="text-destructive">{p.error}</p>}
        <div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />} {open ? "hide" : "how to use, need, source"}
          </Button>
        </div>
        {open && (
          <div className="space-y-2">
            <div>
              <p className="sb-ticker text-[10px] text-muted-foreground">HOW TO USE</p>
              <p className="whitespace-pre-wrap">{p.howToUse}</p>
              {p.kind === "flagship" && (
                <a className="inline-flex items-center gap-1 text-primary hover:underline" href={GUIDE} target="_blank" rel="noreferrer">
                  full guide with viem and cast examples <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            <div>
              <p className="sb-ticker text-[10px] text-muted-foreground">NEED</p>
              <p>{p.need}</p>
            </div>
            <div>
              <p className="sb-ticker text-[10px] text-muted-foreground">WHY</p>
              <p>{p.rationale}</p>
            </div>
            <details>
              <summary className="cursor-pointer text-muted-foreground">source ({p.source.length.toLocaleString()} chars, {p.compiler})</summary>
              <pre className="mt-1 max-h-96 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-snug">{p.source}</pre>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ContractsPanel({ projects }: { projects: ForgeProject[] | undefined }) {
  const sorted = useMemo(() => [...(projects ?? [])].sort((a, b) => b.createdAt - a.createdAt), [projects]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="sb-ticker text-xs text-muted-foreground">
          LAURA&apos;S CONTRACTS ({sorted.length} · Anvil designs and flagship deployments, verified source)
        </h2>
        <span className="sb-ticker text-[11px] text-muted-foreground">· anyone can host a frontend for any of these</span>
      </div>
      {sorted.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">No contracts yet</CardTitle>
            <CardDescription>
              The Ownership Market seeds itself on the first forge tick with a wallet configured; Anvil designs small contracts from X context about every six hours.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {sorted.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
