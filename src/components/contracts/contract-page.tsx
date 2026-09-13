"use client";
import Link from "next/link";
import { useState } from "react";
import { BookOpen, Check, Copy, ExternalLink, FlaskConical, PenLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ContractsShell } from "@/components/contracts/contracts-shell";
import { useForgeProjects, type PublicProject } from "@/components/contracts/use-forge";
import { functionDigest, isConstantGetter, type AbiFunction } from "@/lib/forge/abi-digest";
import { FLAGSHIP_LINKS, REPO_URL } from "@/lib/forge/caps";

const EXPLORER = "https://robinhoodchain.blockscout.com";

function explorerTab(address: string, tab: "read_write_contract" | "contract" | "txs"): string {
  return `${EXPLORER}/address/${address}?tab=${tab}`;
}

function noteFor(p: PublicProject, f: AbiFunction): string | null {
  const notes = p.functionNotes ?? {};
  return notes[f.name] ?? notes[f.signature] ?? null;
}

function Params({ params }: { params: AbiFunction["inputs"] }) {
  if (params.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <span className="font-mono text-[11px]">
      {params.map((x, i) => (
        <span key={`${x.name}-${i}`}>
          {i > 0 && ", "}
          <span className="text-muted-foreground">{x.type}</span> {x.name}
        </span>
      ))}
    </span>
  );
}

function FunctionTable({ p, fns, kind }: { p: PublicProject; fns: AbiFunction[]; kind: "read" | "write" }) {
  const shown = fns.filter((f) => kind === "write" || !isConstantGetter(f));
  const constants = kind === "read" ? fns.filter(isConstantGetter) : [];
  if (fns.length === 0) return <p className="text-xs text-muted-foreground">None.</p>;
  return (
    <div className="space-y-3">
      <div className="divide-y divide-border/60 rounded-md border border-border/60">
        {shown.map((f) => {
          const note = noteFor(p, f);
          return (
            <div key={f.signature} className="grid gap-1 p-3 text-xs sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)]">
              <div className="min-w-0 space-y-1">
                <p className="break-words font-mono text-[12px] font-medium">
                  {f.name}
                  <span className="text-muted-foreground">(</span>
                  <Params params={f.inputs} />
                  <span className="text-muted-foreground">)</span>
                </p>
                {f.outputs.length > 0 && (
                  <p className="text-muted-foreground">
                    returns <Params params={f.outputs} />
                  </p>
                )}
                {f.mutability === "payable" && <Badge variant="outline" className="text-[10px] text-[var(--sb-gold)]">payable: send the native coin with the call</Badge>}
              </div>
              <p className="leading-relaxed text-foreground/90">
                {note ?? (kind === "read" ? "Returns the value named above. Free to call from the explorer's Read tab." : "Writes to the contract; a transaction from a connected wallet on the Write tab.")}
              </p>
            </div>
          );
        })}
      </div>
      {constants.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Constants: {constants.map((c) => `${c.name}${noteFor(p, c) ? ` (${noteFor(p, c)})` : ""}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 font-mono text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked: the address is on screen */
        }
      }}
      title="copy address"
    >
      <span className="break-all">{address}</span>
      {copied ? <Check className="size-3 text-[var(--sb-green)]" /> : <Copy className="size-3" />}
    </Button>
  );
}

export function ContractPage({ address }: { address: string }) {
  const { projects, error, reload } = useForgeProjects();
  const p = (projects ?? []).find((x) => x.contractAddress?.toLowerCase() === address.toLowerCase()) ?? null;

  if (projects === null && !error) {
    return (
      <ContractsShell title="Contract">
        <p className="text-xs text-muted-foreground">Loading…</p>
      </ContractsShell>
    );
  }
  if (error) {
    return (
      <ContractsShell title="Contract">
        <Card className="border-destructive/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-4 text-xs">
            <span>Could not load the contract feed: {error}</span>
            <button type="button" className="text-primary hover:underline" onClick={reload}>
              try again
            </button>
          </CardContent>
        </Card>
      </ContractsShell>
    );
  }
  if (!p) {
    return (
      <ContractsShell title="Contract">
        <Card>
          <CardContent className="space-y-2 py-8 text-center text-sm">
            <p>No contract of LAURA&apos;s at this address in the feed yet.</p>
            <p className="text-xs text-muted-foreground">
              A freshly verified contract can take a few minutes to appear. You can still read it on the{" "}
              <a className="text-primary hover:underline" href={explorerTab(address, "contract")} target="_blank" rel="noreferrer">
                explorer
              </a>
              .
            </p>
            <Link href="/contracts" className="text-xs text-primary hover:underline">
              all contracts
            </Link>
          </CardContent>
        </Card>
      </ContractsShell>
    );
  }

  const d = functionDigest(p.abi);
  const links = p.flagshipKey ? FLAGSHIP_LINKS[p.flagshipKey] : null;
  const addr = p.contractAddress as string;
  const verified = p.status === "verified";

  return (
    <ContractsShell title={p.title} tag={p.contractName}>
      <section className="grid gap-4 md:grid-cols-[1.5fr_1fr]">
        <Card className="sb-panel">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{p.title}</CardTitle>
              {p.kind === "flagship" ? <Badge variant="secondary">flagship · audited in-repo</Badge> : <Badge variant="secondary">Anvil design</Badge>}
              {verified ? (
                <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">source verified{p.verifiedVia ? ` · ${p.verifiedVia}` : ""}</Badge>
              ) : (
                <Badge variant="outline">{p.status}</Badge>
              )}
            </div>
            <CardDescription className="text-xs leading-relaxed">{p.blurb}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">address</span>
              <CopyAddress address={addr} />
            </div>
            <div className="flex flex-wrap gap-3">
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={explorerTab(addr, "read_write_contract")} target="_blank" rel="noreferrer">
                <BookOpen className="size-3" /> read and write on the explorer <ExternalLink className="size-3" />
              </a>
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={explorerTab(addr, "contract")} target="_blank" rel="noreferrer">
                verified source <ExternalLink className="size-3" />
              </a>
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={explorerTab(addr, "txs")} target="_blank" rel="noreferrer">
                transactions <ExternalLink className="size-3" />
              </a>
              {links?.frontendUrl && (
                <a className="inline-flex items-center gap-1 text-primary hover:underline" href={links.frontendUrl} target="_blank" rel="noreferrer">
                  <FlaskConical className="size-3" /> frontend
                </a>
              )}
              {links?.docUrl && (
                <a className="inline-flex items-center gap-1 text-primary hover:underline" href={links.docUrl} target="_blank" rel="noreferrer">
                  guide <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            <div>
              <p className="font-medium">Why it exists</p>
              <p className="leading-relaxed text-muted-foreground">{p.need}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Calling it from the explorer</CardTitle>
            <CardDescription className="text-xs">No frontend needed. Anyone may also host one; the contract is the product.</CardDescription>
          </CardHeader>
          <CardContent className="text-xs">
            <ol className="space-y-2">
              <li className="flex gap-2">
                <span className="font-mono text-primary">1</span>
                <span>
                  Open the{" "}
                  <a className="text-primary hover:underline" href={explorerTab(addr, "read_write_contract")} target="_blank" rel="noreferrer">
                    Read/Write contract tab
                  </a>{" "}
                  on Blockscout.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-primary">2</span>
                <span>
                  <strong>Read</strong> functions answer instantly and cost nothing; fill in the arguments shown and press Query.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-primary">3</span>
                <span>
                  <strong>Write</strong> functions need a wallet on Robinhood Chain (chain id 4663): press Connect wallet, fill the arguments, then Write and confirm the transaction. A payable
                  function also takes an amount of the native coin.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-primary">4</span>
                <span>Every action emits an event; the Transactions tab shows what happened.</span>
              </li>
            </ol>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">How to use it</CardTitle>
        </CardHeader>
        <CardContent className="text-xs leading-relaxed text-foreground/90">{p.howToUse}</CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <BookOpen className="size-4 text-primary" /> Read functions
              <span className="font-normal text-muted-foreground">{d.reads.length}</span>
            </CardTitle>
            <CardDescription className="text-xs">Free. No wallet, no gas, the explorer&apos;s Read tab or any RPC call.</CardDescription>
          </CardHeader>
          <CardContent>
            <FunctionTable p={p} fns={d.reads} kind="read" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <PenLine className="size-4 text-primary" /> Write functions
              <span className="font-normal text-muted-foreground">{d.writes.length}</span>
            </CardTitle>
            <CardDescription className="text-xs">A transaction from a connected wallet; gas is paid in the native coin.</CardDescription>
          </CardHeader>
          <CardContent>
            <FunctionTable p={p} fns={d.writes} kind="write" />
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Source and ABI</CardTitle>
          <CardDescription className="text-xs">
            Compiled with {p.compiler}. The same source is verified on the explorer{p.kind === "flagship" ? "; the audit note and the test suite live in the repo" : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          <details>
            <summary className="cursor-pointer text-primary hover:underline">show source ({p.source.length.toLocaleString()} chars)</summary>
            <pre className="mt-2 max-h-[32rem] overflow-auto rounded-md border border-border/60 bg-black/30 p-3 font-mono text-[11px] leading-relaxed">{p.source}</pre>
          </details>
          <details>
            <summary className="cursor-pointer text-primary hover:underline">show ABI (JSON)</summary>
            <pre className="mt-2 max-h-[24rem] overflow-auto rounded-md border border-border/60 bg-black/30 p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(p.abi, null, 2)}</pre>
          </details>
          <p className="text-muted-foreground">
            Host your own frontend: read with any RPC for chain 4663, write with any EIP-1193 wallet, ABI above.{" "}
            <a className="text-primary hover:underline" href={`${REPO_URL}/blob/main/library/49-forge.md`} target="_blank" rel="noreferrer">
              How these contracts are built
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </ContractsShell>
  );
}
