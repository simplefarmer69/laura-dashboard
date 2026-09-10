"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, usd } from "@/components/console/format";

/* Per surface fee attribution panel fed by /api/feeds/fee-breakdown.
 * Additive component in its own file so parallel workers editing
 * feeds.tsx / overview.tsx stay conflict free. */

type SurfaceWindow = {
  events: number;
  feeEth: number;
  feeUsd: number | null;
  usdSkim?: number;
  native?: Record<string, number>;
};

export type FeeBreakdownData = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  ethUsd: number | null;
  coverage: {
    d1Complete: boolean;
    d7Complete: boolean;
    scannedFromTs: number;
  };
  surfaces: Array<{
    key: string;
    label: string;
    note: string;
    d1: SurfaceWindow;
    d7: SurfaceWindow;
  }>;
  blended: {
    llamaFees24h: number | null;
    llamaRevenue24h: number | null;
    surfaceSum24h: number;
    unattributedUsd: number | null;
  };
};

export function useFeeBreakdown(): FeeBreakdownData | null {
  const [data, setData] = useState<FeeBreakdownData | null>(null);
  const inflight = useRef(false);

  const poll = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch("/api/feeds/fee-breakdown", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as FeeBreakdownData;
        if (body.ok) setData(body);
      }
    } catch {
      /* keep the last snapshot */
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), 120_000);
    return () => clearInterval(id);
  }, [poll]);

  return data;
}

function nativeLabel(native?: Record<string, number>): string | null {
  if (!native) return null;
  const parts = Object.entries(native).map(([sym, amt]) => `${amt.toFixed(2)} ${sym}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

const SURFACE_TONE: Record<string, string> = {
  activations: "text-[var(--sb-gold)]",
  anvil_swaps: "text-[var(--sb-accent)]",
  loans: "text-muted-foreground",
  launchpad_tax: "text-[var(--sb-volt)]",
  smart_lp: "text-[var(--sb-green)]",
  vesting: "text-muted-foreground",
};

export function FeeBreakdownPanel({ data }: { data: FeeBreakdownData | null }) {
  const surfaces = data?.surfaces ?? [];
  const blend = data?.blended ?? null;
  return (
    <Card className="sb-panel">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Layers className="size-3.5 text-primary" /> Fee attribution by surface
          </CardTitle>
          <span className="sb-chip font-mono text-[9px] text-muted-foreground">
            {data ? (data.coverage.d7Complete ? "7d complete" : data.coverage.d1Complete ? "24h complete, 7d filling" : "backfilling") : "loading"}
            {data ? ` . ${ago(data.updatedAt)}` : ""}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Onchain fee events per product surface. The blended DeFiLlama series mixes different event
          sets, this splits them apart.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="pb-1 pr-2 font-normal">Surface</th>
                <th className="pb-1 pr-2 text-right font-normal">Events 24h</th>
                <th className="pb-1 pr-2 text-right font-normal">Fees 24h</th>
                <th className="pb-1 pr-2 text-right font-normal">Events 7d</th>
                <th className="pb-1 text-right font-normal">Fees 7d</th>
              </tr>
            </thead>
            <tbody>
              {surfaces.map((s) => {
                const extra = nativeLabel(s.d1.native);
                return (
                  <tr key={s.key} className="border-t border-border/40">
                    <td className={`py-1 pr-2 ${SURFACE_TONE[s.key] ?? "text-foreground"}`} title={s.note}>
                      {s.label}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono">{s.d1.events}</td>
                    <td className="py-1 pr-2 text-right font-mono">
                      {s.key === "vesting" ? "in kind" : usd(s.d1.feeUsd, 0)}
                      {extra ? <span className="text-muted-foreground"> +{extra}</span> : null}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono">{s.d7.events}</td>
                    <td className="py-1 text-right font-mono">{s.key === "vesting" ? "in kind" : usd(s.d7.feeUsd, 0)}</td>
                  </tr>
                );
              })}
              {surfaces.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-center text-muted-foreground">
                    waiting for the first scan pass
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {blend ? (
          <p className="text-[10px] text-muted-foreground">
            Reconciliation. DeFiLlama fees 24h {usd(blend.llamaFees24h, 0)} vs the surfaces scanned here{" "}
            {usd(blend.surfaceSum24h, 0)}, residual {usd(blend.unattributedUsd, 0)}. The residual is mostly
            the protocol owned Uniswap v4 STONK/ETH LP fee income plus locked LP fee claims, both 100%
            revenue side with no matching volume, which is why revenue share of the blend runs high.
            Activations and loans also pay ~100% to revenue vs ~50% for swaps, but they are small.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
