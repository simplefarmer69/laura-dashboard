"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, ExternalLink, Rocket, Wallet, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { patchJson, type ConsoleState } from "@/components/console/use-swarm-state";
import { EarningsPanel } from "@/components/console/earnings";
import { ContractsPanel } from "@/components/console/contracts";
import { ago, usd } from "@/components/console/format";
import type { LaunchProposal, LaunchStatus } from "@/lib/types";

interface PadInfo {
  address: string;
  launchFeeWei: string;
  launchCount: number;
  bounds: { minStartMcapUsd: number; maxStartMcapUsd: number; minGradMcapUsd: number; maxGradMcapUsd: number };
}

interface LanePadInfo extends PadInfo {
  lane: string;
  quoteSymbol: string;
  kind: "crypto" | "stock";
  closedReason: string | null;
}

interface LaunchpadInfo {
  wallet: { configured: boolean; address: string | null; balanceEth: number | null; funded: boolean };
  /** WETH lane only — kept for older published snapshots. */
  pad: PadInfo | null;
  /** Every quote-lane pad (weth, stonk, usdg + weekday stock lanes). */
  pads?: LanePadInfo[];
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
  caps: {
    /** null since 2026-09-11: no daily count cap */
    maxDeploysPerDay: number | null;
    maxSpendEthPerDeploy: number;
    minDeployGapMinutes?: number;
    walletFloorEth?: number;
  };
  explorer: string;
  autoExecute: boolean;
  /** Deploy window and per-spec projection (absent on older published snapshots). */
  queue?: {
    used24h: number;
    max: number | null;
    minGapMinutes?: number;
    open: boolean;
    nextWindowAt: number;
    reason: string | null;
    projected: Record<string, number>;
  };
}

function utcClock(at: number): string {
  const d = new Date(at);
  const sameDay = d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  const hhmm = d.toISOString().slice(11, 16);
  return sameDay ? `${hhmm} UTC` : `${d.toISOString().slice(5, 10)} ${hhmm} UTC`;
}

export function Launchpad({ state, refresh }: { state: ConsoleState; refresh: () => Promise<void> }) {
  const [info, setInfo] = useState<LaunchpadInfo | null>(null);
  const [infoFailed, setInfoFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/launchpad", { cache: "no-store", signal: AbortSignal.timeout(20_000) })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((d) => {
          if (!live) return;
          setInfo(d as LaunchpadInfo);
          setInfoFailed(false);
        })
        .catch(() => live && setInfoFailed(true));
    const first = setTimeout(load, 0);
    const id = setInterval(load, 30_000);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  const infoLoading = info === null && !infoFailed;

  const launches = useMemo(
    () => [...state.launches].sort((a, b) => b.createdAt - a.createdAt),
    [state.launches],
  );
  const pending = launches.filter((l) => l.status === "pending" || l.status === "approved");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Wallet className="size-4 text-primary" /> Swarm wallet
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {!info ? (
              <p className="sb-ticker text-[11px] text-muted-foreground">
                {infoLoading ? "reading wallet…" : "wallet state unreachable, retrying"}
              </p>
            ) : !info.wallet.configured ? (
              <>
                <Badge variant="outline" className="text-[var(--sb-gold)]">awaiting wallet</Badge>
                <p className="text-xs text-muted-foreground">
                  Set <code className="font-mono">SWARM_WALLET_PRIVATE_KEY</code> once the funding wallet arrives.
                  Specs queue up meanwhile; nothing deploys without it.
                </p>
              </>
            ) : (
              <>
                <p className="break-all font-mono text-xs">{info.wallet.address}</p>
                <p>
                  <span className="text-muted-foreground">Balance </span>
                  <span className={info.wallet.funded ? "text-[var(--sb-green)]" : "text-[var(--sb-gold)]"}>
                    {info.wallet.balanceEth === null ? "unreadable" : `${info.wallet.balanceEth.toFixed(5)} ETH`}
                  </span>
                </p>
                {!info.wallet.funded && (
                  <p className="text-xs text-[var(--sb-gold)]">Not funded yet; deploys stay locked.</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Rocket className="size-4 text-primary" /> Smart Launch V2 pads (quote lanes)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {info?.pads && info.pads.length > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                  {info.pads.map((p) => (
                    <a
                      key={p.lane}
                      className="flex items-baseline justify-between gap-2 hover:underline"
                      href={`${info.explorer}/address/${p.address}`}
                      target="_blank"
                      rel="noreferrer"
                      title={p.closedReason ?? `${p.quoteSymbol}-quoted lane · ${p.address}`}
                    >
                      <span className="font-mono uppercase">{p.lane}</span>
                      <span className={p.closedReason ? "text-[var(--sb-gold)]" : "text-muted-foreground"}>
                        {p.launchCount} · {p.closedReason ? "closed" : "open"}
                      </span>
                    </a>
                  ))}
                </div>
                <p className="pt-1 text-xs text-muted-foreground">
                  Mint picks the lane per launch; stock lanes close on weekends. Bounds (all lanes):
                  start {usd(info.pads[0].bounds.minStartMcapUsd)}–{usd(info.pads[0].bounds.maxStartMcapUsd)},
                  graduation {usd(info.pads[0].bounds.minGradMcapUsd)}–{usd(info.pads[0].bounds.maxGradMcapUsd)}
                </p>
              </>
            ) : info?.pad ? (
              <>
                <p>
                  <span className="text-muted-foreground">Launches on WETH pad </span>
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
            ) : infoLoading ? (
              <p className="sb-ticker text-[11px] text-muted-foreground">reading pad state…</p>
            ) : (
              <p className="text-muted-foreground">Pad state unavailable, RPC not answering.</p>
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
              <p>· Specs auto-approve and deploy in queue order; no operator step anywhere in the path</p>
            ) : (
              <p>· Every spec needs operator approval before deploy</p>
            )}
            <p>
              · No daily launch limit; deploys pace ≥{info?.queue?.minGapMinutes ?? info?.caps.minDeployGapMinutes ?? "—"} min apart so each gets its own arrival
              {info?.queue && (
                <span className="text-foreground">
                  {" "}
                  · {info.queue.used24h} deployed in the last 24h · {info.queue.open ? "window open" : `next window ${utcClock(info.queue.nextWindowAt)}`}
                </span>
              )}
            </p>
            <p>
              · Max {info ? info.caps.maxSpendEthPerDeploy : "—"} ETH spend per deploy (fee + 2x gas)
              {info?.caps.walletFloorEth !== undefined && ` · wallet never deploys below ${info.caps.walletFloorEth} ETH`}
            </p>
            <p>· Specs re-validated against live pad bounds at deploy time</p>
            <p>· Logo + community links attach automatically after each deploy</p>
          </CardContent>
        </Card>
      </div>

      <EarningsPanel state={state} />

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="sb-ticker text-xs text-muted-foreground">
          LAUNCH QUEUE ({pending.length} {info?.autoExecute ? "queued · autonomous deploy" : "awaiting action"})
        </h2>
        {info?.autoExecute && info.queue && pending.length > 0 && (
          <span className="sb-ticker text-[11px] text-muted-foreground">
            {info.queue.open
              ? "· deploy window open, next spec goes out on the next tick"
              : `· ${info.queue.reason ?? `next window ${utcClock(info.queue.nextWindowAt)}`}`}
          </span>
        )}
      </div>

      {launches.length === 0 && (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">No launches designed yet</CardTitle>
            <CardDescription>Mint designs at most one launch spec per cycle. Run a cycle to get the first one.</CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2 2xl:grid-cols-3">
        {launches.map((l) => (
          <LaunchCard
            key={l.id}
            launch={l}
            explorer={info?.explorer ?? "https://robinhoodchain.blockscout.com"}
            walletReady={info?.wallet.funded ?? false}
            autoExecute={info?.autoExecute ?? false}
            projectedAt={info?.queue?.projected[l.id] ?? null}
            refresh={refresh}
          />
        ))}
      </div>

      <ContractsPanel projects={state.forgeProjects} />

      {info && info.grid.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Launcher floor (live, newest first)</CardTitle>
            <CardDescription>Public Stonk Launcher grid: the competition and context Mint sees each cycle.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
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

function statusBadge(s: LaunchStatus, autoExecute: boolean, projectedAt: number | null) {
  switch (s) {
    case "pending":
      return <Badge variant="secondary">{autoExecute ? "auto-approving" : "pending review"}</Badge>;
    case "approved":
      if (autoExecute)
        return (
          <Badge className="bg-primary/15 text-primary">
            queued{projectedAt ? ` · deploys ~${utcClock(projectedAt)}` : " · deploys at next window"}
          </Badge>
        );
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
  autoExecute,
  projectedAt,
  refresh,
}: {
  launch: LaunchProposal;
  explorer: string;
  walletReady: boolean;
  autoExecute: boolean;
  projectedAt: number | null;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  /* Compact by default: the queue holds dozens of launches and the full spec
     card made the tab scroll for pages (operator request 2026-09-12). Launches
     that still need attention open expanded. */
  const needsAttention = l.status === "pending" || l.status === "approved" || l.status === "deploying" || Boolean(l.error);
  const [open, setOpen] = useState(needsAttention);

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

  const taxLine = `${(l.startTaxBps / 100).toFixed(0)}%→${(l.postTaxBps / 100).toFixed(1)}%`;

  return (
    <Card size={open ? "default" : "sm"}>
      <CardHeader className={open ? "pb-2" : ""}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-3">
            <LaunchArt id={l.id} symbol={l.symbol} size={open ? 80 : 40} />
            <div className="min-w-0">
              <CardTitle className={open ? "text-base" : "truncate text-sm"}>
                {l.name} <span className="font-mono text-sm text-primary">${l.symbol}</span>
              </CardTitle>
              <CardDescription className="truncate text-[11px]">
                {ago(l.createdAt)} · {l.lane.toUpperCase()} lane · {usd(l.startMcapUsd)}→{usd(l.gradMcapUsd)} · tax {taxLine}
                {l.designer === "tokenintel" ? " · by Ticker" : ""}
                {l.buyOnlyFallback ? " · buy-only refused by pad, sells enabled" : l.buyOnlyRequested ? " · buy-only requested" : ""}
                {open && l.artMotif ? ` · ${l.artMotif}/${l.artPalette ?? "emerald"}` : ""}
              </CardDescription>
              {!open && l.message && <p className="mt-0.5 line-clamp-1 text-xs italic text-muted-foreground">“{l.message}”</p>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {statusBadge(l.status, autoExecute, projectedAt)}
            <button
              type="button"
              aria-label={open ? "Collapse launch details" : "Expand launch details"}
              className="p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
          </div>
        </div>
      </CardHeader>
      {open && (
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
            <p className="border border-[var(--sb-gold)]/40 bg-[var(--sb-gold)]/10 px-2 py-1 text-xs text-[var(--sb-gold)]">
              Supply not loaded yet; the executor arms it automatically (registered, not live).
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
          {l.status === "approved" && autoExecute && (
            <p className="border border-primary/30 bg-primary/5 px-2 py-1 text-xs text-muted-foreground">
              In the autonomous deploy queue: the executor takes specs in order at the pacing gap (no daily count cap)
              {projectedAt ? `; this one is projected for ~${utcClock(projectedAt)}` : ""}. No approval step exists; Reject is the operator veto.
            </p>
          )}
          {(l.status === "pending" || l.status === "approved") && (
            <div className="flex flex-wrap gap-2 pt-1">
              {l.status === "pending" && !autoExecute && (
                <Button size="sm" disabled={busy} onClick={() => void act("approve")}>
                  <Check className="size-3.5" /> Approve spec
                </Button>
              )}
              {l.status === "approved" && !autoExecute && (
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
      )}
    </Card>
  );
}

/** Procedural token art — the logo humans see next to the token on the launcher. */
function LaunchArt({ id, symbol, size = 80 }: { id: string; symbol: string; size?: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div
      className="relative shrink-0 overflow-hidden border border-primary/30 bg-black/50 shadow-[0_0_16px_var(--sb-glow)]"
      style={{ width: size, height: size }}
    >
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
          width={size}
          height={size}
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
