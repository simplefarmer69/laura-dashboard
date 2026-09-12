import { executeTreasuryBuy } from "@/lib/launchpad/treasury";
import { enterLpPosition, exitLpPosition, stakeLpPosition } from "@/lib/launchpad/smart-lp";
import { runEarningsMaintenance } from "@/lib/launchpad/earnings";
import {
  ECO_CAPS,
  TREASURY_CAPS,
  buyEligibility,
  ecoBuyEligibility,
  lpDeployedEthEquiv,
} from "@/lib/launchpad/treasury-caps";
import { ecoBuy, ecoCandidates, ecoSell, unwrapWeth, valueEcoPositions, walletBusy, type EcoCandidate } from "@/lib/launchpad/treasury-ops";
import { generateStructured, type ResolvedModel } from "@/lib/swarm/llm";
import { agentSystem, treasurerMock, treasurerPrompt, treasurerSchema, type CycleContext, type TreasurerOut } from "@/lib/swarm/tasks";
import { newId, pushEvent } from "@/lib/store";
import type { Agent, SwarmState, TreasuryOpAction, TreasuryOpRecord } from "@/lib/types";

/**
 * Purser: the treasury agent that decides and executes (operator grant
 * 2026-09-12). One structured call reads the sleeves, the live curves, Vault's
 * memo and its own ledger, then each action runs through the existing
 * simulate-first, hard-capped executors. Nothing executes on a fallback
 * plan, and nothing executes while another rail holds the wallet.
 */

function log(msg: string): void {
  console.log(`[purser ${new Date().toISOString()}] ${msg}`);
}

const eth = (n: number, d = 4) => `${n.toFixed(d)} ETH`;

/** Deterministic sleeve digest; every number Purser may cite comes from here. */
export async function treasurySleeves(state: SwarmState, now = Date.now()): Promise<string> {
  const t = state.treasury;
  const buys = state.treasuryBuys ?? [];
  const elig = buyEligibility(state, now);
  const stonkBought = buys.reduce((s, b) => s + b.tokensOut, 0);
  const spent24h = elig.spent24hEth;
  const openLp = (state.treasuryLp ?? []).filter((p) => !p.exitedAt);
  const eco = await valueEcoPositions(state).catch(() => []);
  const ecoSpent = ecoBuyEligibility(state, "0x0", now).spent24hEth;
  const lines: string[] = [];
  if (!t) lines.push("- No treasury snapshot yet this session.");
  else {
    lines.push(
      `- Wallet ${t.walletAddress ?? "?"}: ${eth(t.ethBalance)} native (floor ${TREASURY_CAPS.treasuryFloorEth} ETH on every spend; spendable above floor ${eth(Math.max(0, t.ethBalance - TREASURY_CAPS.treasuryFloorEth))}) · ${t.wethBalance.toFixed(5)} WETH idle creator fees (unwrap turns them into spendable ETH) · ${t.stonkBalance.toFixed(2)} $STONKBROKER held in the wallet (not counting LP).`,
    );
    lines.push(
      `- Creator-fee income: ${t.totalEarnedQuote.toFixed(4)} quote earned lifetime across ${t.launches.length} launches · claimable now ${t.totalClaimableQuote.toFixed(6)} · bonded-pool LP fees pending ${(t.totalLpPendingQuote ?? 0).toFixed(6)} / collected ${(t.totalLpCollectedQuote ?? 0).toFixed(6)} (snapshot ${Math.round((now - t.updatedAt) / 60_000)}m old).`,
    );
  }
  lines.push(
    `- $STONKBROKER accumulation: ${buys.length} capped buys, ${stonkBought.toFixed(2)} tokens bought lifetime · 24h spend ${eth(spent24h)} of ${TREASURY_CAPS.maxEthPer24h} · next buy ${elig.eligible ? `ELIGIBLE NOW for up to ${eth(elig.amountEth)}` : `blocked: ${elig.reason}${elig.nextEligibleAt ? ` (frees ~${new Date(elig.nextEligibleAt).toISOString().slice(11, 16)}Z)` : ""}`}.`,
  );
  if (openLp.length === 0) {
    lines.push(`- Smart LP: no open position · cap ${TREASURY_CAPS.maxLpEthEquivTotal} ETH-equiv · entry pairs the wallet's $STONKBROKER with matched ETH (needs ≥${TREASURY_CAPS.minLpEthSide} ETH side).`);
  } else {
    for (const p of openLp) {
      const ageH = ((now - p.ts) / 3600_000).toFixed(1);
      lines.push(
        `- Smart LP #${p.tokenId} (${ageH}h old, ${p.gauge ? "staked, earning $UP" : "UNSTAKED"}): entered ${eth(p.ethIn)} + ${p.stonkIn.toFixed(2)} STONK · now ${p.currentEthValue !== undefined ? `${eth(p.currentEthValue)} + ${(p.currentStonkValue ?? 0).toFixed(2)} STONK` : "value not yet read"} · pending $UP ${(p.pendingUpRewards ?? 0).toFixed(4)} · deployed ${lpDeployedEthEquiv(state).toFixed(4)} of ${TREASURY_CAPS.maxLpEthEquivTotal} ETH-equiv cap.`,
      );
    }
  }
  if (eco.length === 0) {
    lines.push(`- Eco positions: none held · eco 24h spend ${eth(ecoSpent)} of ${ECO_CAPS.maxEthPer24h} · room for ${ECO_CAPS.maxOpenPositions} tokens at ≤${ECO_CAPS.maxEthPerTrade} ETH each.`);
  } else {
    for (const p of eco) {
      const pnl = p.ethNow === null ? "unquotable (curve closed?)" : `${(p.ethNow + p.ethOut - p.ethIn >= 0 ? "+" : "")}${(p.ethNow + p.ethOut - p.ethIn).toFixed(5)} ETH vs cost`;
      lines.push(
        `- Eco $${p.symbol} (${p.token}, launch #${p.launchId}): holding ${p.tokens.toFixed(2)} tokens · cost ${eth(p.ethIn, 5)}, sold back ${eth(p.ethOut, 5)} so far · sell-now value ${p.ethNow === null ? "n/a" : eth(p.ethNow, 5)} · ${pnl} · ${p.tradable ? "tradable on the curve" : "NOT tradable on the curve right now"} · last trade ${((now - p.lastTs) / 3600_000).toFixed(1)}h ago.`,
      );
    }
    lines.push(`- Eco 24h spend ${eth(ecoSpent)} of ${ECO_CAPS.maxEthPer24h} · ${eco.length}/${ECO_CAPS.maxOpenPositions} position slots used.`);
  }
  return lines.join("\n");
}

export function candidatesDigest(cands: EcoCandidate[]): string {
  if (cands.length === 0) return "No live curves on the WETH pad right now (or the read failed). Eco buys are off the table this cycle.";
  return cands
    .map(
      (c) =>
        `- $${c.symbol} launch #${c.launchId} ${c.token}${c.held ? " [HELD]" : ""}: ${c.ageHours < 48 ? `${c.ageHours.toFixed(1)}h` : `${(c.ageHours / 24).toFixed(1)}d`} old · mcap $${Math.round(c.mcapUsd).toLocaleString()} of $${Math.round(c.gradMcapUsd).toLocaleString()} grad (${c.progressPct.toFixed(0)}% up the curve) · ${c.buyCount} buys · ${c.realQuoteEth.toFixed(4)} ETH raised · tax ${(c.taxBps / 100).toFixed(1)}% · sells ${c.sellsEnabled ? "on" : "OFF"} · creator ${c.creator.slice(0, 8)}`,
    )
    .join("\n");
}

function ledgerDigest(state: SwarmState): string {
  const ops = (state.treasuryOps ?? []).slice(-14).reverse();
  if (ops.length === 0) return "No plans executed yet. This is your first pass.";
  return ops
    .map((o) => `- ${new Date(o.ts).toISOString().slice(0, 16).replace("T", " ")}Z ${o.action} → ${o.outcome}: ${o.detail.slice(0, 220)}${o.txHash ? ` (tx ${o.txHash.slice(0, 12)}…)` : ""}`)
    .join("\n");
}

function vaultMemoDigest(state: SwarmState): string {
  const memo = [...state.drafts].filter((d) => d.agentId === "vault").sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!memo) return "Vault has not written a memo yet.";
  return `(${new Date(memo.createdAt).toISOString().slice(0, 16).replace("T", " ")}Z) ${memo.body.replace(/\s+/g, " ").slice(0, 3000)}`;
}

export interface TreasurerResult {
  status: "ok" | "error" | "skipped";
  summary: string;
  durationMs: number;
  usedMock: boolean;
  repaired: boolean;
}

interface ExecOutcome {
  outcome: TreasuryOpRecord["outcome"];
  detail: string;
  txHash?: string | null;
}

async function execute(action: TreasurerOut["actions"][number], state: SwarmState, cands: EcoCandidate[], runId: string): Promise<ExecOutcome> {
  const a = action.action as TreasuryOpAction;
  if (a === "hold") return { outcome: "executed", detail: `hold: ${action.reason}` };
  if (walletBusy()) return { outcome: "skipped", detail: "another rail holds the wallet this tick (deploy, buy or LP in flight); retry next plan" };
  switch (a) {
    case "unwrap-weth": {
      const r = await unwrapWeth({ amountEth: action.amountEth ?? undefined, reason: action.reason, runId });
      if (r.ok && r.sent) return { outcome: "executed", detail: `unwrapped ${r.ethOut.toFixed(5)} WETH → ETH`, txHash: r.txHash };
      return { outcome: r.ok ? "skipped" : "failed", detail: r.reason };
    }
    case "buy-stonk": {
      const r = await executeTreasuryBuy();
      if (r.ok && r.sent) return { outcome: "executed", detail: `bought ${r.buy.tokensOut.toFixed(2)} $STONKBROKER for ${r.buy.ethIn} ETH`, txHash: r.buy.txHash };
      return { outcome: r.ok ? "skipped" : "failed", detail: r.reason };
    }
    case "lp-enter": {
      const r = await enterLpPosition();
      if (r.ok && r.sent) {
        const staked = await stakeLpPosition(r.position.id);
        return { outcome: "executed", detail: `entered Smart LP #${r.position.tokenId} with ${r.position.ethIn.toFixed(4)} ETH + ${r.position.stonkIn.toFixed(2)} STONK${staked.ok && staked.sent ? ", staked in the gauge" : `; stake ${staked.ok ? staked.reason : `failed: ${staked.reason}`}`}`, txHash: r.position.mintTxHash };
      }
      return { outcome: r.ok ? "skipped" : "failed", detail: r.reason };
    }
    case "lp-exit": {
      const open = (state.treasuryLp ?? []).find((p) => !p.exitedAt);
      if (!open) return { outcome: "skipped", detail: "no open Smart LP position to exit" };
      const r = await exitLpPosition(open.id);
      if (r.ok && r.sent) return { outcome: "executed", detail: `exited Smart LP #${open.tokenId}; funds back in the wallet`, txHash: r.position.exitTxHash ?? null };
      return { outcome: r.ok ? "skipped" : "failed", detail: r.reason };
    }
    case "collect-earnings": {
      if (globalThis.__lauraEarnings) globalThis.__lauraEarnings.lastRefreshAt = 0;
      await runEarningsMaintenance(state);
      return { outcome: "executed", detail: "earnings pass forced: claimable creator fees and bonded-pool LP fees above the dust threshold were swept (see earnings events)" };
    }
    case "eco-buy": {
      const token = (action.token ?? "").toLowerCase();
      const cand = cands.find((c) => c.token.toLowerCase() === token);
      if (!cand) return { outcome: "skipped", detail: `token ${action.token ?? "(none)"} is not in this cycle's candidate list; refused` };
      const r = await ecoBuy({ launchId: cand.launchId, token: cand.token, amountEth: action.amountEth ?? ECO_CAPS.maxEthPerTrade, reason: action.reason, runId });
      if (r.ok && r.sent) return { outcome: "executed", detail: `bought ${r.trade.tokenAmount.toFixed(2)} $${r.trade.symbol} for ${r.trade.ethAmount.toFixed(4)} ETH (launch #${r.trade.launchId})`, txHash: r.trade.txHash };
      return { outcome: r.ok ? "skipped" : "failed", detail: r.reason };
    }
    case "eco-sell": {
      const token = (action.token ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) return { outcome: "skipped", detail: `eco-sell needs a held token address; got ${action.token ?? "(none)"}` };
      const r = await ecoSell({ token: token as `0x${string}`, fraction: action.fraction ?? 1, reason: action.reason, runId });
      if (r.ok && r.sent) return { outcome: "executed", detail: `sold ${r.trade.tokenAmount.toFixed(2)} $${r.trade.symbol} for ${r.trade.ethAmount.toFixed(4)} ETH`, txHash: r.trade.txHash };
      return { outcome: r.ok ? "skipped" : "failed", detail: r.reason };
    }
    default: {
      const never: never = a;
      return { outcome: "skipped", detail: `unknown action ${String(never)}` };
    }
  }
}

export async function runTreasurer(input: { state: SwarmState; resolved: ResolvedModel; ctx: CycleContext; agent: Agent; runId: string }): Promise<TreasurerResult> {
  const { state, resolved, ctx, agent, runId } = input;
  const t0 = Date.now();
  const cands = await ecoCandidates(state).catch((err) => {
    log(`candidate read failed (non-fatal): ${String(err).slice(0, 160)}`);
    return [] as EcoCandidate[];
  });
  const sleeves = await treasurySleeves(state);
  const out = await generateStructured(resolved, {
    schema: treasurerSchema,
    system: agentSystem(agent),
    prompt: treasurerPrompt(ctx, { sleeves, candidates: candidatesDigest(cands), vaultMemo: vaultMemoDigest(state), ledger: ledgerDigest(state) }),
    mock: treasurerMock,
  });
  const plan = out.value;
  const records: TreasuryOpRecord[] = [];

  if (out.usedMock) {
    records.push({ id: newId("top"), ts: Date.now(), runId, action: "hold", outcome: "skipped", detail: "fallback plan (no live model): nothing executes without a live judgment" });
  } else if (!state.settings.autoTreasuryOps) {
    for (const a of plan.actions) {
      records.push({ id: newId("top"), ts: Date.now(), runId, action: a.action, outcome: "skipped", detail: `execution off (settings.autoTreasuryOps=false): ${a.reason.slice(0, 200)}` });
    }
  } else {
    for (const a of plan.actions.slice(0, 4)) {
      try {
        const r = await execute(a, state, cands, runId);
        records.push({ id: newId("top"), ts: Date.now(), runId, action: a.action, outcome: r.outcome, detail: r.detail, txHash: r.txHash ?? null });
        log(`${a.action} → ${r.outcome}: ${r.detail.slice(0, 160)}`);
      } catch (err) {
        records.push({ id: newId("top"), ts: Date.now(), runId, action: a.action, outcome: "failed", detail: String(err).slice(0, 400) });
        log(`${a.action} threw: ${String(err).slice(0, 200)}`);
      }
    }
  }

  state.treasuryOps = [...(state.treasuryOps ?? []), ...records];
  const executed = records.filter((r) => r.outcome === "executed" && r.action !== "hold").length;
  const summaryLine = records.map((r) => `${r.action}:${r.outcome}`).join(", ");
  pushEvent(state, {
    kind: "treasury.plan",
    agentId: "treasurer",
    title: out.usedMock ? "Purser held (fallback, no live model)" : `Purser plan: ${summaryLine}`,
    detail: `${plan.assessment.slice(0, 900)}\n\n${records.map((r) => `- ${r.action} → ${r.outcome}: ${r.detail}`).join("\n")}\n\nRationale: ${plan.rationale.slice(0, 600)}`,
    refId: runId,
  });
  return {
    status: "ok",
    summary: `${summaryLine}${executed > 0 ? ` · ${executed} on-chain action(s)` : ""}${out.usedMock ? " (fallback)" : ""}`,
    durationMs: Date.now() - t0,
    usedMock: out.usedMock,
    repaired: out.repaired,
  };
}
