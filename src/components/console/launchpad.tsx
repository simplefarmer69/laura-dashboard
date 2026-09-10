"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, Rocket, Wallet, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { patchJson, type ConsoleState } from "@/components/console/use-swarm-state";
import { ago, usd } from "@/components/console/format";
import type { LaunchProposal, LaunchStatus } from "@/lib/types";

interface LaunchpadInfo {
  wallet: { configured: boolean; address: string | null; balanceEth: number | null; funded: boolean };
  pad: {
    address: string;
    launchFeeWei: string;
    launchCount: number;
    bounds: { minStartMcapUsd: number; maxStartMcapUsd: number; minGradMcapUsd: number; maxGradMcapUsd: number };
  } | null;
  grid: {
    token: string;
    name: string;
    symbol: string;
    mcapUsd: number;
    curvePct: number;
    holderCount: number;
    graduated: boolean;
    createdAt: string;
  }[];
  caps: { maxDeploysPerDay: number; maxSpendEthPerDeploy: number };
  explorer: string;
  autoExecute: boolean;
}

export function Launchpad({ state, refresh }: { state: ConsoleState; refresh: () => Promise<void> }) {
  const [info, setInfo] = useState<LaunchpadInfo | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/launchpad", { cache: "no-store", signal: AbortSignal.timeout(20_000) })
        .then((r) => r.json())
        .then((d) => live && setInfo(d as LaunchpadInfo))
        .catch(() => undefined);
    const first = setTimeout(load, 0);
    const id = setInterval(load, 30_000);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  const launches = useMemo(
    () => [...state.launches].sort((a, b) => b.createdAt - a.createdAt),
    [state.launches],
  );
  const pending = launches.filter((l) => l.status === "pending" || l.status === "approved");

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Wallet className="size-4 text-primary" /> Swarm wallet
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {!info ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : !info.wallet.configured ? (
              <>
                <Badge variant="outline" className="text-amber-400">awaiting wallet</Badge>
                <p className="text-xs text-muted-foreground">
                  Set <code className="font-mono">SWARM_WALLET_PRIVATE_KEY</code> once the funding wallet arrives.
                  Specs queue up meanwhile — nothing deploys without it.
                </p>
              </>
            ) : (
              <>
                <p className="break-all font-mono text-xs">{info.wallet.address}</p>
                <p>
                  <span className="text-muted-foreground">Balance </span>
                  <span className={info.wallet.funded ? "text-[var(--sb-green)]" : "text-amber-400"}>
                    {info.wallet.balanceEth === null ? "unreadable" : `${info.wallet.balanceEth.toFixed(5)} ETH`}
                  </span>
                </p>
                {!info.wallet.funded && (
                  <p className="text-xs text-amber-400">Not funded yet — deploys stay locked.</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Rocket className="size-4 text-primary" /> Smart Launch V2 pad (WETH lane)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {info?.pad ? (
              <>
                <p>
                  <span className="text-muted-foreground">Launches on pad </span>
                  <span className="font-mono">{info.pad.launchCount}</span>
                  <span className="text-muted-foreground"> · fee </span>
                  <span className="font-mono">{(Number(info.pad.launchFeeWei) / 1e18).toFixed(4)} ETH</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Live bounds: start {usd(info.pad.bounds.minStartMcapUsd)}–{usd(info.pad.bounds.maxStartMcapUsd)},
                  graduation {usd(info.pad.bounds.minGradMcapUsd)}–{usd(info.pad.bounds.maxGradMcapUsd)}
                </p>
                <a
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  href={`${info.explorer}/address/${info.pad.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {info.pad.address.slice(0, 10)}… on Blockscout <ExternalLink className="size-3" />
                </a>
              </>
            ) : (
              <p className="text-muted-foreground">Pad state unavailable.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-sm">
              Guardrails
              {info?.autoExecute && (
                <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">FULL AUTONOMY</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            {info?.autoExecute ? (
              <p>· Specs auto-approve and deploy the moment the wallet is funded</p>
            ) : (
              <p>· Every spec needs operator approval before deploy</p>
            )}
            <p>· Max {info?.caps.maxDeploysPerDay ?? 3} deploys per 24h</p>
            <p>· Max {info?.caps.maxSpendEthPerDeploy ?? 0.02} ETH spend per deploy (fee + 2x gas)</p>
            <p>· Specs re-validated against live pad bounds at deploy time</p>
            <p>· Logo + community links attach automatically after each deploy</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <h2 className="sb-ticker text-xs text-muted-foreground">LAUNCH QUEUE ({pending.length} awaiting action)</h2>
      </div>

      {launches.length === 0 && (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">No launches designed yet</CardTitle>
            <CardDescription>Mint designs at most one launch spec per cycle. Run a cycle to get the first one.</CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {launches.map((l) => (
          <LaunchCard key={l.id} launch={l} explorer={info?.explorer ?? "https://robinhoodchain.blockscout.com"} walletReady={info?.wallet.funded ?? false} refresh={refresh} />
        ))}
      </div>

      {info && info.grid.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Launcher floor (live, newest first)</CardTitle>
            <CardDescription>Public Stonk Launcher grid — the competition and context Mint sees each cycle.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              {info.grid.map((t) => (
                <div key={t.token} className="flex items-baseline justify-between gap-2 border-b border-border/40 py-1">
                  <span className="truncate">
                    {t.name} <span className="text-muted-foreground">${t.symbol}</span>
                  </span>
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {usd(t.mcapUsd)} · {t.curvePct.toFixed(1)}% · {t.holderCount}h{t.graduated ? " · grad" : ""}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function statusBadge(s: LaunchStatus) {
  switch (s) {
    case "pending":
      return <Badge variant="secondary">pending review</Badge>;
    case "approved":
      return <Badge className="bg-primary/15 text-primary">approved · ready to deploy</Badge>;
    case "deploying":
      return <Badge className="bg-primary/15 text-primary sb-blink">deploying…</Badge>;
    case "deployed":
      return <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">deployed</Badge>;
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "rejected":
      return <Badge variant="outline">rejected</Badge>;
    default: {
      const never: never = s;
      return never;
    }
  }
}

function LaunchCard({
  launch: l,
  explorer,
  walletReady,
  refresh,
}: {
  launch: LaunchProposal;
  explorer: string;
  walletReady: boolean;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function act(action: "approve" | "reject" | "deploy") {
    setBusy(true);
    try {
      await patchJson(`/api/launches/${l.id}`, { action });
      toast.success(
        action === "deploy" ? `Deployed ${l.name} ($${l.symbol})` : `${action === "approve" ? "Approved" : "Rejected"} ${l.name}`,
      );
    } catch (err) {
      toast.error(`${action} failed`, { description: String(err) });
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3">
            <LaunchArt id={l.id} symbol={l.symbol} />
            <div>
              <CardTitle className="text-base">
                {l.name} <span className="font-mono text-sm text-primary">${l.symbol}</span>
              </CardTitle>
              <CardDescription>
                designed by Mint · {ago(l.createdAt)} · {l.lane.toUpperCase()} lane
                {l.artMotif ? ` · ${l.artMotif}/${l.artPalette ?? "emerald"}` : ""}
              </CardDescription>
            </div>
          </div>
          {statusBadge(l.status)}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {l.message && (
          <blockquote className="border-l-2 border-primary/60 bg-primary/5 px-3 py-2">
            <p className="font-mono text-[10px] tracking-wider text-primary">LAURA SAYS</p>
            <p className="mt-0.5 italic">“{l.message}”</p>
          </blockquote>
        )}
        <p className="text-muted-foreground">{l.concept}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-3">
          <Spec label="supply" value={l.supplyTokens.toLocaleString()} />
          <Spec label="start mcap" value={usd(l.startMcapUsd)} />
          <Spec label="grad mcap" value={usd(l.gradMcapUsd)} />
          <Spec label="start tax" value={`${(l.startTaxBps / 100).toFixed(1)}%`} />
          <Spec label="decay" value={`${l.taxDecayPerMinuteBps} bps/min`} />
          <Spec label="post tax" value={`${(l.postTaxBps / 100).toFixed(1)}%`} />
          <Spec label="sells" value={l.sellsEnabled ? "enabled" : "off"} />
          <Spec label="buffer" value={`${l.bufferSecs}s`} />
        </div>
        <p className="text-xs text-muted-foreground">{l.rationale}</p>
        {l.error && <p className="border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">{l.error}</p>}
        {l.status === "deployed" && !l.armedAt && (
          <p className="border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-xs text-amber-400">
            Supply not loaded yet — the executor arms it automatically (registered, not live).
          </p>
        )}
        {l.status === "deployed" && l.txHash && (
          <div className="space-y-1 text-xs">
            {l.tokenAddress && (
              <a className="flex items-center gap-1 text-primary hover:underline" href={`${explorer}/address/${l.tokenAddress}`} target="_blank" rel="noreferrer">
                token {l.tokenAddress.slice(0, 12)}… <ExternalLink className="size-3" />
              </a>
            )}
            <a className="flex items-center gap-1 text-primary hover:underline" href={`${explorer}/tx/${l.txHash}`} target="_blank" rel="noreferrer">
              tx {l.txHash.slice(0, 14)}… <ExternalLink className="size-3" />
            </a>
            {l.imageHash && <p className="text-muted-foreground">logo live on launcher · {l.imageHash.slice(0, 14)}…</p>}
          </div>
        )}
        {(l.status === "pending" || l.status === "approved") && (
          <div className="flex flex-wrap gap-2 pt-1">
            {l.status === "pending" && (
              <Button size="sm" disabled={busy} onClick={() => void act("approve")}>
                <Check className="size-3.5" /> Approve spec
              </Button>
            )}
            {l.status === "approved" && (
              <Button size="sm" disabled={busy || !walletReady} onClick={() => void act("deploy")} title={walletReady ? "Deploy on-chain" : "Wallet not funded yet"}>
                <Rocket className="size-3.5" /> {walletReady ? "Deploy on-chain" : "Deploy (locked: wallet)"}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("reject")}>
              <X className="size-3.5" /> Reject
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Procedural token art — the logo humans see next to the token on the launcher. */
function LaunchArt({ id, symbol }: { id: string; symbol: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative size-20 shrink-0 overflow-hidden rounded-md border border-primary/30 bg-black/50 shadow-[0_0_16px_rgba(207,255,4,0.12)]">
      {!loaded && !failed && <div className="absolute inset-0 animate-pulse bg-muted/40" />}
      {failed ? (
        <div className="flex size-full items-center justify-center font-mono text-xl text-muted-foreground">
          {symbol.slice(0, 1)}
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/launches/${id}/image`}
          alt={`${symbol} token logo`}
          width={80}
          height={80}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`size-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-muted-foreground">{label} </span>
      {value}
    </span>
  );
}
