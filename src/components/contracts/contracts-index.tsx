"use client";
import Link from "next/link";
import { ExternalLink, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ContractsShell } from "@/components/contracts/contracts-shell";
import { useForgeProjects, type PublicProject } from "@/components/contracts/use-forge";
import { functionDigest } from "@/lib/forge/abi-digest";
import { FLAGSHIP_LINKS, REPO_URL } from "@/lib/forge/caps";
import type { ForgeStatus } from "@/lib/types";

function statusLabel(s: ForgeStatus): string {
  switch (s) {
    case "pending":
      return "designed";
    case "approved":
      return "queued to deploy";
    case "deployed":
      return "deployed, verifying";
    case "verified":
      return "verified";
    case "failed":
      return "failed";
    case "rejected":
      return "rejected";
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

function ProjectRow({ p }: { p: PublicProject }) {
  const d = functionDigest(p.abi);
  const href = p.contractAddress ? `/contracts/${p.contractAddress.toLowerCase()}` : null;
  const frontend = p.flagshipKey ? FLAGSHIP_LINKS[p.flagshipKey]?.frontendUrl : null;
  return (
    <Card className={p.kind === "flagship" ? "border-primary/40" : undefined}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">
            {href ? (
              <Link href={href} className="hover:underline">
                {p.title}
              </Link>
            ) : (
              p.title
            )}{" "}
            <span className="font-mono text-xs text-muted-foreground">{p.contractName}</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            {p.kind === "flagship" && <Badge variant="secondary">flagship · audited</Badge>}
            <Badge variant="outline" className={p.status === "verified" ? "text-[var(--sb-green)]" : undefined}>
              {statusLabel(p.status)}
            </Badge>
          </div>
        </div>
        <CardDescription className="text-xs leading-relaxed">{p.blurb}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-muted-foreground">
          {d.reads.length} read · {d.writes.length} write function{d.writes.length === 1 ? "" : "s"}
        </span>
        {href && (
          <Link href={href} className="text-primary hover:underline">
            how to use it
          </Link>
        )}
        {frontend && (
          <a className="inline-flex items-center gap-1 text-primary hover:underline" href={frontend} target="_blank" rel="noreferrer">
            <FlaskConical className="size-3" /> frontend
          </a>
        )}
        {p.explorerUrl && (
          <a className="inline-flex items-center gap-1 text-primary hover:underline" href={p.explorerUrl} target="_blank" rel="noreferrer">
            explorer <ExternalLink className="size-3" />
          </a>
        )}
      </CardContent>
    </Card>
  );
}

export function ContractsIndex() {
  const { projects, error, reload } = useForgeProjects();
  const live = (projects ?? []).filter((p) => p.contractAddress).sort((a, b) => (b.deployedAt ?? b.createdAt) - (a.deployedAt ?? a.createdAt));
  const queued = (projects ?? []).filter((p) => !p.contractAddress && (p.status === "approved" || p.status === "pending"));
  return (
    <ContractsShell title="Contracts" tag="built and deployed by LAURA · Robinhood Chain">
      <Card className="sb-panel">
        <CardHeader>
          <CardTitle className="text-base">Contracts LAURA wrote, verified and runs on Robinhood Chain</CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Every contract here has its source verified on the explorer, so the Read and Write tabs work for anyone without a frontend. Each page lists the read functions (free, no
            wallet) and the write functions (a transaction from your wallet) with what to pass and what happens. Flagship contracts are audited in the repo before deploy; Anvil designs are
            small standalone tools people asked for on X. Anyone may host a frontend for any of them.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 text-xs">
          <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`${REPO_URL}/blob/main/library/49-forge.md`} target="_blank" rel="noreferrer">
            how Anvil works <ExternalLink className="size-3" />
          </a>
          <Link href="/lab" className="inline-flex items-center gap-1 text-primary hover:underline">
            <FlaskConical className="size-3" /> The Lab (ownership market frontend)
          </Link>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-4 text-xs">
            <span>Could not load the contract feed: {error}</span>
            <button type="button" className="text-primary hover:underline" onClick={reload}>
              try again
            </button>
          </CardContent>
        </Card>
      )}
      {projects === null && !error && <p className="text-xs text-muted-foreground">Loading contracts…</p>}
      {projects !== null && live.length === 0 && !error && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">No contract deployed yet. The first one lands here the moment it verifies.</CardContent>
        </Card>
      )}
      <section className="grid gap-3">
        {live.map((p) => (
          <ProjectRow key={p.id} p={p} />
        ))}
      </section>
      {queued.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Designed, waiting to deploy</h2>
          <div className="grid gap-3">
            {queued.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </div>
        </section>
      )}
    </ContractsShell>
  );
}
