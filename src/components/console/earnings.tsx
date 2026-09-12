"use client";

import { Coins } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, when } from "@/components/console/format";
import { TREASURY_CAPS, buyEligibility, lpDeployedEthEquiv } from "@/lib/launchpad/treasury-caps";
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
            <Coins className="size-4 text-[var(--sb-gold)]" /> LAURA economics: creator earnings
          </span>
          {autoClaim ? (
            <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">AUTO-CLAIM ON</Badge>
          ) : (
            <Badge variant="outline" className="text-[var(--sb-gold)]">claim prepared · sending off</Badge>
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
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-5">
              <Stat label="treasury ETH" value={t.ethBalance.toFixed(5)} />
              <Stat label="WETH in wallet" value={t.wethBalance.toFixed(6)} />
              <Stat label="curve fees earned" value={t.totalEarnedQuote.toFixed(6)} />
              <Stat label="LP fees collected" value={(t.totalLpCollectedQuote ?? 0).toFixed(6)} />
              <Stat label="claimable" value={t.totalClaimableQuote.toFixed(6)} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              WETH in the wallet is the sum of two income streams: curve-trade fees pushed per trade on
              WETH-lane launches, plus swap fees collected from bonded pools&apos; locked LP. &quot;Curve fees
              earned&quot; alone understates her income — the LP line is the rest of it. Non-WETH lanes earn in
              their own quote token (STONK, USDG), so the totals mix units on purpose.
            </p>
            {t.launches.length > 0 && (
              <p className="sb-ticker text-[11px] text-muted-foreground">PER LAUNCH ({t.launches.length}) · scroll</p>
            )}
            {t.launches.length === 0 ? (
              <p className="text-xs text-muted-foreground">No deployed launches to track yet.</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto border border-border/40 px-2" aria-label={`${t.launches.length} launches tracked`}>
                {t.launches.map((e) => (
                  <div
                    key={e.proposalId}
                    className="flex flex-col gap-0.5 border-b border-border/40 py-1 text-xs sm:flex-row sm:items-baseline sm:justify-between sm:gap-2"
                  >
                    <span className="truncate">
                      ${e.symbol} <span className="text-muted-foreground">#{e.launchId} · {e.lane.toUpperCase()}</span>
                      {e.graduated && (
                        <span className="ml-1 text-[var(--sb-green)]">{e.bonded ? "bonded" : "graduated"}</span>
                      )}
                    </span>
                    <span className="min-w-0 font-mono text-muted-foreground sm:shrink-0 sm:text-right">
                      earned {e.earnedQuote.toFixed(6)} · claimable {e.claimableQuote.toFixed(6)} · {e.tradeCount} trades
                      {e.claimedQuote > 0 ? ` · claimed ${e.claimedQuote.toFixed(6)}` : ""}
                      {e.bonded
                        ? ` · LP fees ${e.lpStaked ? "staked (to voters)" : `pending ${(e.lpPendingQuote ?? 0).toFixed(6)}`}${(e.lpCollectedQuote ?? 0) > 0 ? `, collected ${(e.lpCollectedQuote ?? 0).toFixed(6)}` : ""}`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Earnings compound the treasury: creator fees fund future launches inside the inviolable caps
              (spend per deploy, pacing between deploys and the wallet floor; the Launchpad tab shows the live numbers). Claimable is the flushCreatorQuote fallback,
              normally zero because fees are pushed per trade.
            </p>
            <TreasuryOps state={state} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Treasury operations: mission-token accumulation with treasury ETH.
 * Buys are $STONKBROKER only (own-token buys are code-blocked as wash
 * trading); the TREASURY_CAPS rails bound every number shown here.
 */
function TreasuryOps({ state }: { state: ConsoleState }) {
  const buys = state.treasuryBuys ?? [];
  const lastBuy = buys.length > 0 ? buys[buys.length - 1] : null;
  const elig = buyEligibility(state);
  const stonkBought = buys.reduce((s, b) => s + b.tokensOut, 0);
  const on = state.settings.autoTreasuryOps;

  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Treasury ops: $STONKBROKER accumulation</span>
        {on ? (
          <Badge className="bg-[var(--sb-green)]/15 text-[var(--sb-green)]">AUTO-BUY ON</Badge>
        ) : (
          <Badge variant="outline" className="text-[var(--sb-gold)]">auto-buy off</Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-4">
        <Stat label="$STONK accumulated" value={stonkBought.toFixed(2)} />
        <Stat label="held (wallet)" value={(state.treasury?.stonkBalance ?? 0).toFixed(2)} />
        <Stat label="24h spend" value={`${elig.spent24hEth.toFixed(4)}/${TREASURY_CAPS.maxEthPer24h} ETH`} />
        <Stat
          label="next buy"
          value={elig.eligible ? "eligible now" : elig.nextEligibleAt ? when(elig.nextEligibleAt) : "—"}
        />
      </div>
      {lastBuy && (
        <p className="font-mono text-[11px] text-muted-foreground" title={when(lastBuy.ts)}>
          last buy {ago(lastBuy.ts)}: {lastBuy.ethIn.toFixed(4)} ETH → {lastBuy.tokensOut.toFixed(2)} $STONKBROKER · tx{" "}
          {lastBuy.txHash.slice(0, 10)}…
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Hard caps: ≤{TREASURY_CAPS.maxEthPerBuy} ETH/buy · ≤{TREASURY_CAPS.maxEthPer24h} ETH/24h · ≥
        {TREASURY_CAPS.minBuyGapHours}h between buys · never below the {TREASURY_CAPS.treasuryFloorEth} ETH
        treasury floor · mission token only, never LAURA&apos;s own launches.
      </p>
      <SmartLp state={state} />
    </div>
  );
}

/**
 * Smart LP: full-range STONKBROKER/WETH position(s) on the Stonk Exchange
 * vDEX, staked in the gauge for $UP emissions. Deployed capital is bounded
 * by TREASURY_CAPS.maxLpEthEquivTotal; the exit path (unstake → decrease →
 * collect) is one code path with no lockups.
 */
function SmartLp({ state }: { state: ConsoleState }) {
  const positions = (state.treasuryLp ?? []).filter((p) => !p.exitedAt);
  const deployed = lpDeployedEthEquiv(state);

  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Smart LP: Stonk Exchange (vDEX)</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {deployed.toFixed(4)}/{TREASURY_CAPS.maxLpEthEquivTotal} ETH-equiv deployed
        </span>
      </div>
      {positions.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No open position. The scheduler enters one full-range STONKBROKER/WETH position (and stakes it
          for $UP) once accumulated $STONKBROKER is worth pairing.
        </p>
      ) : (
        positions.map((p) => (
          <div key={p.id} className="space-y-1">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-4">
              <Stat label="position" value={`#${p.tokenId} full-range`} />
              <Stat
                label="entry"
                value={`${p.ethIn.toFixed(4)} ETH + ${p.stonkIn.toFixed(0)} STONK`}
              />
              <Stat
                label="now"
                value={
                  p.currentEthValue !== undefined
                    ? `${p.currentEthValue.toFixed(4)} ETH + ${(p.currentStonkValue ?? 0).toFixed(0)} STONK`
                    : "refresh pending"
                }
              />
              <Stat
                label={p.gauge ? "staked · $UP earned" : "unstaked"}
                value={p.gauge ? (p.pendingUpRewards ?? 0).toFixed(4) : "earning swap fees"}
              />
            </div>
            <p className="font-mono text-[11px] text-muted-foreground" title={when(p.ts)}>
              entered {ago(p.ts)} · mint tx {p.mintTxHash.slice(0, 10)}…
              {p.stakeTxHash ? ` · stake tx ${p.stakeTxHash.slice(0, 10)}…` : ""}
              {p.valueUpdatedAt ? ` · value ${ago(p.valueUpdatedAt)}` : ""}
            </p>
          </div>
        ))
      )}
    </div>
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
