"use client";

import { Coins } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, when } from "@/components/console/format";
import { TREASURY_CAPS, buyEligibility } from "@/lib/launchpad/treasury";
import type { ConsoleState } from "@/components/console/use-swarm-state";

/**
 * LAURA's economics: treasury balances plus per-launch creator earnings.
 * Creator fees (16.5% of every curve-trade tax) are push-paid to the wallet
 * per trade — WETH on the WETH lane — so "earned" is real income already
 * received; "claimable" is the fallback ledger (flushCreatorQuote) that only
 * fills when a push transfer failed.
 */
export function EarningsPanel({ state }: { state: ConsoleState }) {
  const t = state.treasury;
  const autoClaim = state.settings.autoClaimEarnings;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Coins className="size-4 text-[var(--sb-gold)]" /> LAURA economics — creator earnings
          </span>
          {autoClaim ? (
            <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">AUTO-CLAIM ON</Badge>
          ) : (
            <Badge variant="outline" className="text-amber-400">claim prepared · sending off</Badge>
          )}
        </CardTitle>
        <CardDescription>
          16.5% of every curve-trade tax on her launches is pushed straight to the treasury wallet
          {t?.updatedAt ? ` · snapshot ${ago(t.updatedAt)}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!t ? (
          <p className="text-muted-foreground">First on-chain snapshot pending (refreshes every ~10 min).</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-4">
              <Stat label="treasury ETH" value={t.ethBalance.toFixed(5)} />
              <Stat label="WETH (fees)" value={t.wethBalance.toFixed(6)} />
              <Stat label="total earned" value={t.totalEarnedQuote.toFixed(6)} />
              <Stat label="claimable" value={t.totalClaimableQuote.toFixed(6)} />
            </div>
            {t.launches.length === 0 ? (
              <p className="text-xs text-muted-foreground">No deployed launches to track yet.</p>
            ) : (
              <div className="space-y-1">
                {t.launches.map((e) => (
                  <div
                    key={e.proposalId}
                    className="flex items-baseline justify-between gap-2 border-b border-border/40 py-1 text-xs"
                  >
                    <span className="truncate">
                      ${e.symbol} <span className="text-muted-foreground">#{e.launchId} · {e.lane.toUpperCase()}</span>
                      {e.graduated && (
                        <span className="ml-1 text-[var(--sb-green)]">{e.bonded ? "bonded" : "graduated"}</span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      earned {e.earnedQuote.toFixed(6)} · claimable {e.claimableQuote.toFixed(6)} · {e.tradeCount} trades
                      {e.claimedQuote > 0 ? ` · claimed ${e.claimedQuote.toFixed(6)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Earnings compound the treasury: creator fees fund future launches inside the inviolable caps
              (max 3 deploys/24h, max 0.02 ETH per deploy). Claimable is the flushCreatorQuote fallback —
              normally zero because fees are pushed per trade.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-muted-foreground">{label} </span>
      {value}
    </span>
  );
}
