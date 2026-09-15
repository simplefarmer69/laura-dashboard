import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { ARBITRUM_ONE, LAUNCH_CHAINS, ROBINHOOD_CHAIN, type LaunchChainKey } from "@/lib/launchpad/contracts";
import { getAccount } from "@/lib/launchpad/service";
import { BRIDGE_CAPS, bridgeEligibility } from "@/lib/launchpad/treasury-caps";
import { beginChainWork } from "@/lib/chain-work";
import { loadState, newId, pushEvent, updateState } from "@/lib/store";
import type { SwarmState, TreasuryBridge } from "@/lib/types";

/**
 * ETH bridge between the treasury's two chains through Relay (relay.link).
 *
 * Why Relay and not the canonical Orbit bridge: Robinhood Chain is an Arbitrum
 * Orbit chain settling to Arbitrum One, so the canonical path from Robinhood
 * to Arbitrum is an L3→L2 withdrawal (ArbSys.withdrawEth + an Outbox claim
 * after the challenge window, days) — useless for funding a launch lane
 * today. Relay is an intent bridge: one deposit tx on the origin chain to
 * Relay's receiver, a solver fills on the destination within seconds, and a
 * public status endpoint reports the fill tx. Relay lists Robinhood Chain
 * (id 4663, deposits enabled) and Arbitrum One (42161); a 1 ETH quote on
 * 2026-09-15 returned 0.99899 ETH out (fee ≈ 0.1%, ~1 s).
 *
 * Every bridge is simulate-free by nature (a plain value transfer with
 * calldata) so the guards are all pre-send: role cap, dust floor, Robinhood
 * treasury floor after sending, quoted fee share, and a structural check that
 * the quote's single step is one transaction on the origin chain whose value
 * equals the amount and whose recipient is Relay's receiver — never a token
 * approval, never a second step. Status is polled after the deposit and
 * again on later Purser ticks until Relay reports success/failure/refund.
 */

const RELAY_API = "https://api.relay.link";
const ZERO = "0x0000000000000000000000000000000000000000";
const TIMEOUT_MS = 20_000;

function log(msg: string): void {
  console.log(`[bridge ${new Date().toISOString()}] ${msg}`);
}

const robinhood = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(undefined, { retryCount: 3, retryDelay: 600 }) });
const arbitrum = createPublicClient({ chain: ARBITRUM_ONE, transport: http(undefined, { retryCount: 3, retryDelay: 600 }) });

function clientFor(key: LaunchChainKey) {
  return key === "arbitrum" ? arbitrum : robinhood;
}

export interface RelayQuote {
  requestId: string;
  tx: { to: `0x${string}`; data: `0x${string}`; value: bigint; chainId: number };
  checkEndpoint: string;
  amountInEth: number;
  amountOutEth: number;
  feeEth: number;
  feeBps: number;
  timeEstimateSecs: number | null;
}

interface RelayQuoteResponse {
  steps?: Array<{
    id: string;
    kind: string;
    items?: Array<{
      data?: { to?: string; data?: string; value?: string; chainId?: number };
      check?: { endpoint?: string; method?: string };
    }>;
  }>;
  fees?: Record<string, { amount?: string; amountFormatted?: string }>;
  details?: {
    currencyIn?: { amountFormatted?: string };
    currencyOut?: { amountFormatted?: string };
    timeEstimate?: number;
  };
  message?: string;
  errorCode?: string;
}

/** Quote a native-ETH bridge. Read-only. */
export async function relayQuote(opts: {
  user: `0x${string}`;
  from: LaunchChainKey;
  to: LaunchChainKey;
  amountEth: number;
}): Promise<RelayQuote> {
  const originChainId = LAUNCH_CHAINS[opts.from].chain.id;
  const destinationChainId = LAUNCH_CHAINS[opts.to].chain.id;
  const amountWei = parseEther(opts.amountEth.toFixed(18));
  const res = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      user: opts.user,
      recipient: opts.user,
      originChainId,
      destinationChainId,
      originCurrency: ZERO,
      destinationCurrency: ZERO,
      amount: amountWei.toString(),
      tradeType: "EXACT_INPUT",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const q = (await res.json().catch(() => ({}))) as RelayQuoteResponse;
  if (!res.ok) throw new Error(`Relay quote HTTP ${res.status}: ${q.message ?? q.errorCode ?? "no detail"}`);

  const steps = q.steps ?? [];
  if (steps.length !== 1 || steps[0].kind !== "transaction" || (steps[0].items?.length ?? 0) !== 1) {
    throw new Error(`Relay quote has an unexpected shape (${steps.length} steps: ${steps.map((s) => `${s.id}/${s.kind}`).join(", ")}); a native ETH bridge is exactly one deposit transaction`);
  }
  const item = steps[0].items![0];
  const tx = item.data ?? {};
  if (!tx.to || !/^0x[0-9a-fA-F]{40}$/.test(tx.to) || !tx.data || tx.chainId !== originChainId) {
    throw new Error(`Relay deposit tx malformed (to ${tx.to}, chainId ${tx.chainId}, expected ${originChainId})`);
  }
  const value = BigInt(tx.value ?? "0");
  if (value !== amountWei) throw new Error(`Relay deposit value ${formatEther(value)} ETH does not equal the requested ${opts.amountEth} ETH`);
  const check = item.check?.endpoint ?? "";
  const requestId = check.match(/requestId=(0x[0-9a-fA-F]+)/)?.[1] ?? "";
  if (!requestId) throw new Error("Relay quote carries no requestId in its status check");

  const amountOutEth = Number(q.details?.currencyOut?.amountFormatted ?? 0);
  const feeEth = Object.entries(q.fees ?? {})
    .filter(([k]) => k === "gas" || k === "relayer" || k === "app")
    .reduce((s, [, v]) => s + Number(v.amountFormatted ?? 0), 0);
  const feeBps = opts.amountEth > 0 ? (feeEth / opts.amountEth) * 10_000 : 0;
  return {
    requestId,
    tx: { to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value, chainId: originChainId },
    checkEndpoint: check,
    amountInEth: opts.amountEth,
    amountOutEth,
    feeEth,
    feeBps,
    timeEstimateSecs: q.details?.timeEstimate ?? null,
  };
}

export interface RelayStatus {
  status: "waiting" | "pending" | "success" | "failure" | "refund" | "unknown";
  fillTxHash: string | null;
  raw?: unknown;
}

/** Relay's status for a request id (v2 intents status). */
export async function relayStatus(requestId: string): Promise<RelayStatus> {
  const res = await fetch(`${RELAY_API}/intents/status/v2?requestId=${requestId}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json().catch(() => ({}))) as { status?: string; txHashes?: string[]; outTxs?: Array<{ hash?: string }> };
  const s = (j.status ?? "unknown") as RelayStatus["status"];
  const fill = j.txHashes?.[0] ?? j.outTxs?.[0]?.hash ?? null;
  return { status: ["waiting", "pending", "success", "failure", "refund"].includes(s) ? s : "unknown", fillTxHash: fill, raw: j };
}

export type BridgeResult =
  | { ok: true; sent: true; bridge: TreasuryBridge }
  | { ok: true; sent: false; reason: string }
  | { ok: false; reason: string };

/**
 * Bridge ETH from Robinhood Chain to Arbitrum One (or back). `by: "operator"`
 * is the directed grant (cap BRIDGE_CAPS.operatorMaxEthPerBridge); Purser's
 * `by: "treasurer"` runs through bridgeEligibility's top-up caps.
 */
export async function bridgeEth(opts: {
  amountEth: number;
  reason: string;
  by: "operator" | "treasurer";
  from?: LaunchChainKey;
  to?: LaunchChainKey;
  /** Seconds to wait for Relay's fill before returning (status keeps refreshing on later ticks). */
  waitSecs?: number;
}): Promise<BridgeResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const from = opts.from ?? "robinhood";
  const to = opts.to ?? "arbitrum";
  if (from === to) return { ok: false, reason: "origin and destination are the same chain" };
  const state = await loadState();

  let amountEth = opts.amountEth;
  if (opts.by === "treasurer") {
    const arbBal = Number(formatEther(await arbitrum.getBalance({ address: account.address })));
    const elig = bridgeEligibility(state, amountEth, arbBal);
    if (!elig.eligible) return { ok: true, sent: false, reason: elig.reason };
    amountEth = elig.amountEth;
  } else if (amountEth > BRIDGE_CAPS.operatorMaxEthPerBridge) {
    return { ok: false, reason: `amount ${amountEth} ETH exceeds the ${BRIDGE_CAPS.operatorMaxEthPerBridge} ETH operator per-bridge cap` };
  }
  if (amountEth < BRIDGE_CAPS.minEth) return { ok: true, sent: false, reason: `amount ${amountEth} ETH is under the ${BRIDGE_CAPS.minEth} ETH dust floor` };

  const origin = clientFor(from);
  const balWei = await origin.getBalance({ address: account.address });
  const balEth = Number(formatEther(balWei));
  if (from === "robinhood" && balEth - amountEth < BRIDGE_CAPS.robinhoodFloorEth) {
    return {
      ok: true,
      sent: false,
      reason: `Robinhood balance ${balEth.toFixed(4)} ETH minus ${amountEth} ETH would breach the ${BRIDGE_CAPS.robinhoodFloorEth} ETH treasury floor`,
    };
  }
  if (from === "arbitrum" && balEth - amountEth < 0.002) {
    return { ok: true, sent: false, reason: `Arbitrum balance ${balEth.toFixed(4)} ETH cannot cover ${amountEth} ETH plus gas` };
  }

  const quote = await relayQuote({ user: account.address, from, to, amountEth });
  if (quote.feeBps > BRIDGE_CAPS.maxFeeBps) {
    return { ok: true, sent: false, reason: `Relay fee ${quote.feeBps.toFixed(1)} bps (${quote.feeEth.toFixed(6)} ETH) exceeds the ${BRIDGE_CAPS.maxFeeBps} bps cap; not bridging` };
  }
  if (quote.amountOutEth <= 0 || quote.amountOutEth < amountEth * (1 - BRIDGE_CAPS.maxFeeBps / 10_000)) {
    return { ok: true, sent: false, reason: `Relay quote out ${quote.amountOutEth} ETH is below the fee-capped minimum for ${amountEth} ETH in` };
  }

  const release = beginChainWork(`bridge:${from}->${to}`);
  try {
    const wallet = createWalletClient({ account, chain: LAUNCH_CHAINS[from].chain, transport: http() });
    const gas = await origin.estimateGas({ account, to: quote.tx.to, data: quote.tx.data, value: quote.tx.value });
    const txHash = await wallet.sendTransaction({ to: quote.tx.to, data: quote.tx.data, value: quote.tx.value, gas: (gas * 12n) / 10n });
    log(`deposit sent ${amountEth} ETH ${from}→${to} tx ${txHash} (relay request ${quote.requestId}, quoted out ${quote.amountOutEth} ETH, fee ${quote.feeBps.toFixed(1)} bps)`);
    const receipt = await origin.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
    if (receipt.status !== "success") return { ok: false, reason: `Relay deposit reverted: ${txHash}` };

    const bridge: TreasuryBridge = {
      id: newId("bridge"),
      ts: Date.now(),
      fromChainId: LAUNCH_CHAINS[from].chain.id,
      toChainId: LAUNCH_CHAINS[to].chain.id,
      amountEth,
      expectedOutEth: quote.amountOutEth,
      receivedEth: null,
      feeEth: quote.feeEth,
      requestId: quote.requestId,
      txHash,
      fillTxHash: null,
      status: "pending",
      by: opts.by,
      reason: opts.reason,
    };

    /* Wait briefly for the fill; Relay usually lands inside a few seconds. */
    const deadline = Date.now() + (opts.waitSecs ?? 90) * 1000;
    const destBefore = await clientFor(to).getBalance({ address: account.address }).catch(() => null);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const st = await relayStatus(quote.requestId).catch(() => null);
      if (!st) continue;
      if (st.status === "success") {
        bridge.status = "success";
        bridge.fillTxHash = st.fillTxHash;
        break;
      }
      if (st.status === "failure" || st.status === "refund") {
        bridge.status = st.status === "refund" ? "refund" : "failed";
        break;
      }
    }
    if (bridge.status === "success") {
      const destAfter = await clientFor(to).getBalance({ address: account.address }).catch(() => null);
      if (destBefore !== null && destAfter !== null && destAfter > destBefore) {
        bridge.receivedEth = Number(formatEther(destAfter - destBefore));
      }
    }

    await updateState((s) => {
      (s.treasuryBridges ??= []).push(bridge);
      pushEvent(s, {
        kind: "treasury.bridge",
        agentId: opts.by === "operator" ? "operator" : "treasurer",
        title: `${opts.by === "operator" ? "Operator-directed" : "Purser"} bridge: ${amountEth} ETH ${LAUNCH_CHAINS[from].label} → ${LAUNCH_CHAINS[to].label} (${bridge.status})`,
        detail: `${opts.reason} · Relay request ${quote.requestId} · deposit ${LAUNCH_CHAINS[from].explorer}/tx/${txHash}${bridge.fillTxHash ? ` · fill ${LAUNCH_CHAINS[to].explorer}/tx/${bridge.fillTxHash}` : ""} · quoted out ${quote.amountOutEth.toFixed(6)} ETH, fee ${quote.feeEth.toFixed(6)} ETH (${quote.feeBps.toFixed(1)} bps)${bridge.receivedEth !== null ? ` · received ${bridge.receivedEth.toFixed(6)} ETH` : ""} · caps: operator ≤${BRIDGE_CAPS.operatorMaxEthPerBridge} ETH/bridge, Purser ≤${BRIDGE_CAPS.maxEthPerBridge} ETH/bridge and ${BRIDGE_CAPS.maxEthPer7d} ETH/7d, fee ≤${BRIDGE_CAPS.maxFeeBps} bps, Robinhood floor ${BRIDGE_CAPS.robinhoodFloorEth} ETH`,
        refId: bridge.id,
      });
    });
    log(`bridge ${bridge.id} ${bridge.status}${bridge.fillTxHash ? ` fill ${bridge.fillTxHash}` : ""}${bridge.receivedEth !== null ? ` received ${bridge.receivedEth} ETH` : ""}`);
    return { ok: true, sent: true, bridge };
  } finally {
    release();
  }
}

/** Re-polls Relay for every pending bridge and records the outcome. Safe to call every tick. */
export async function refreshPendingBridges(): Promise<number> {
  const state = await loadState();
  const pending = (state.treasuryBridges ?? []).filter((b) => b.status === "pending");
  if (pending.length === 0) return 0;
  let changed = 0;
  for (const b of pending) {
    const st = await relayStatus(b.requestId).catch(() => null);
    if (!st || st.status === "waiting" || st.status === "pending" || st.status === "unknown") {
      /* A deposit older than a day with no fill is treated as failed so the caps stop counting it as spent. */
      if (Date.now() - b.ts > 24 * 3_600_000) {
        await updateState((s) => {
          const live = (s.treasuryBridges ?? []).find((x) => x.id === b.id);
          if (live && live.status === "pending") live.status = "failed";
        });
        changed++;
      }
      continue;
    }
    await updateState((s) => {
      const live = (s.treasuryBridges ?? []).find((x) => x.id === b.id);
      if (!live) return;
      live.status = st.status === "success" ? "success" : st.status === "refund" ? "refund" : "failed";
      live.fillTxHash = st.fillTxHash ?? live.fillTxHash;
      pushEvent(s, {
        kind: "treasury.bridge",
        agentId: "system",
        title: `Bridge ${live.id} resolved: ${live.status}`,
        detail: `Relay request ${live.requestId}${live.fillTxHash ? ` · fill tx ${live.fillTxHash}` : ""}`,
        refId: live.id,
      });
    });
    changed++;
  }
  return changed;
}

/** Native balances on both launch chains, for the Purser digest and the console. */
export async function chainBalances(): Promise<Record<LaunchChainKey, number | null>> {
  const account = getAccount();
  if (!account) return { robinhood: null, arbitrum: null };
  const [rh, arb] = await Promise.all([
    robinhood.getBalance({ address: account.address }).then((b) => Number(formatEther(b))).catch(() => null),
    arbitrum.getBalance({ address: account.address }).then((b) => Number(formatEther(b))).catch(() => null),
  ]);
  return { robinhood: rh, arbitrum: arb };
}

/** The bridge/Arbitrum block of Purser's prompt input. */
export function bridgeDigest(state: SwarmState, balances: Record<LaunchChainKey, number | null>): string {
  const bridges = state.treasuryBridges ?? [];
  const recent = bridges.slice(-3).reverse();
  const arbLaunches = state.launches.filter((l) => l.lane === "arbweth" && l.status === "deployed").length;
  const weekAgo = Date.now() - 7 * 24 * 3_600_000;
  const spent7d = bridges.filter((b) => b.by === "treasurer" && b.ts >= weekAgo && b.status !== "failed" && b.status !== "refund").reduce((s, b) => s + b.amountEth, 0);
  const lines = [
    `Arbitrum One wallet: ${balances.arbitrum === null ? "unread" : `${balances.arbitrum.toFixed(5)} ETH`} (same address as Robinhood Chain). Robinhood Chain wallet: ${balances.robinhood === null ? "unread" : `${balances.robinhood.toFixed(4)} ETH`}.`,
    `Arbitrum launches deployed so far: ${arbLaunches}. The arbweth lane deploys while the Arbitrum balance is above 0.003 ETH; a createLaunch + arm there costs ~0.0001 ETH in gas.`,
    `bridge-arb (Purser top-up rail): only when Arbitrum holds < ${BRIDGE_CAPS.arbitrumTopUpBelowEth} ETH; ≤${BRIDGE_CAPS.maxEthPerBridge} ETH per bridge, ≤${BRIDGE_CAPS.maxEthPer7d} ETH per 7 days (used ${spent7d.toFixed(4)}), Relay fee ≤${BRIDGE_CAPS.maxFeeBps} bps, Robinhood floor ${BRIDGE_CAPS.robinhoodFloorEth} ETH kept.`,
    recent.length
      ? `Recent bridges: ${recent.map((b) => `${new Date(b.ts).toISOString().slice(0, 16).replace("T", " ")}Z ${b.amountEth} ETH ${b.fromChainId === 4663 ? "RH→ARB" : "ARB→RH"} ${b.status}${b.receivedEth !== null ? ` (received ${b.receivedEth.toFixed(5)})` : ""} by ${b.by}`).join("; ")}`
      : "No bridges yet.",
  ];
  return lines.join("\n");
}
