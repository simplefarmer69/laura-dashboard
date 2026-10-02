import { beginChainWork, chainWorkOpen } from "@/lib/chain-work";
import { loadState, newId, pushEvent, saveState, updateState } from "@/lib/store";
import { ensureLaunchArt } from "@/lib/launchpad/art";
import { walletStatus } from "@/lib/launchpad/service";
import { explorerTokenUrl } from "@/lib/launchpad/contracts";
import { checkVerified, submitVerification } from "@/lib/forge/verify";
import { DIRECT_LAUNCH_CAPS, directCapacity, queuedDirectLaunches } from "@/lib/direct-launch/caps";
import { TAX_TOKEN_CONTRACT_NAME, TAX_TOKEN_SOURCE } from "@/lib/direct-launch/contract";
import { deployDirectLaunch } from "@/lib/direct-launch/onchain";
import { launchOnPons, ponsTokenUrl } from "@/lib/direct-launch/pons";
import type { DirectLaunchSpec } from "@/lib/direct-launch/spec";
import type { Agent, CycleRun, DirectLaunch, SwarmState } from "@/lib/types";

/**
 * Runs the direct launch queue (own tax tokens on the vDEX, Pons launches)
 * when full launch autonomy is on. Called by the scheduler every tick:
 * (1) reconcile anything left in "deploying" by a dead process, (2) verify
 * pass: submit and check the tax token source on the explorer, (3) deploy
 * at most one approved spec within DIRECT_LAUNCH_CAPS. Failures back off.
 */

const RETRY_BACKOFF_MS = 20 * 60_000;
const VERIFY_BACKOFF_MS = 10 * 60_000;
const MAX_VERIFY_ATTEMPTS = 8;
/** A record stuck in "deploying" with no open chain work for this long is treated as a dead process. */
const ORPHAN_AFTER_MS = 30 * 60_000;
const PUBLIC_SITE = "https://laura.stonkbrokers.io";

declare global {
  var __lauraDirectLaunchExecutor:
    | {
        running: boolean;
        nextAttemptAt: Record<string, number>;
        lastWindowNote: number;
      }
    | undefined;
}

function execState() {
  if (!globalThis.__lauraDirectLaunchExecutor) {
    globalThis.__lauraDirectLaunchExecutor = { running: false, nextAttemptAt: {}, lastWindowNote: 0 };
  }
  return globalThis.__lauraDirectLaunchExecutor;
}

function log(msg: string): void {
  console.log(`[direct-launch ${new Date().toISOString()}] ${msg}`);
}

/** Logo URL the Pons page and the explorer can fetch (the public viewer serves launch art from the snapshot). */
export function directLaunchImageUrl(id: string): string {
  return `${PUBLIC_SITE}/api/launches/${id}/image`;
}

/** Writes Mint's design into the queue (auto approved under launch autonomy) and renders its art. */
export async function enqueueDirectLaunch(state: SwarmState, run: CycleRun, spec: DirectLaunchSpec, designer: Agent): Promise<DirectLaunch> {
  const autonomous = state.settings.autoExecuteLaunches;
  const launch: DirectLaunch = {
    id: newId("direct"),
    cycleId: run.id,
    createdAt: Date.now(),
    venue: spec.venue,
    name: spec.name,
    symbol: spec.symbol,
    supplyTokens: spec.supplyTokens,
    startMcapUsd: spec.startMcapUsd,
    rangeTopMcapUsd: spec.rangeTopMcapUsd,
    startTaxBps: spec.startTaxBps,
    floorTaxBps: spec.floorTaxBps,
    decayBpsPerMinute: spec.decayBpsPerMinute,
    holderShareBps: spec.holderShareBps,
    burnShareBps: spec.burnShareBps,
    rewardMode: spec.rewardMode,
    creatorTaxBps: spec.creatorTaxBps,
    devBuyEth: spec.devBuyEth,
    buybackEnabled: spec.buybackEnabled,
    concept: spec.concept,
    rationale: spec.rationale,
    message: spec.message,
    artMotif: spec.artMotif,
    artPalette: spec.artPalette,
    artStyle: spec.artStyle,
    imageQuery: spec.imageQuery,
    status: autonomous ? "approved" : "pending",
    reviewedAt: autonomous ? Date.now() : null,
    reviewerNote: autonomous ? "Auto-approved: operator granted full launch autonomy" : null,
    txHash: null,
    tokenAddress: null,
    poolAddress: null,
    lpTokenId: null,
    devBuyTxHash: null,
    deployedAt: null,
    verifiedAt: null,
    verifyAttempts: 0,
    costEth: null,
    pageUrl: null,
    error: null,
  };
  state.directLaunches = [...(state.directLaunches ?? []), launch];
  designer.stats.drafts += 1;
  if (autonomous) designer.stats.approved += 1;
  const econ =
    spec.venue === "direct"
      ? `buy tax ${spec.startTaxBps} to ${spec.floorTaxBps} bps over ${((spec.startTaxBps - spec.floorTaxBps) / Math.max(1, spec.decayBpsPerMinute)).toFixed(0)} min, ${spec.holderShareBps / 100}% of it to holders (${spec.rewardMode}), ${spec.burnShareBps / 100}% burned, pool from $${spec.startMcapUsd.toLocaleString()} to $${spec.rangeTopMcapUsd.toLocaleString()}`
      : `Pons curve, creator tax ${spec.creatorTaxBps / 100}%${spec.devBuyEth > 0 ? `, opening buy ${spec.devBuyEth} ETH` : ""}`;
  pushEvent(state, {
    kind: "direct.proposed",
    agentId: designer.id,
    title: `${designer.name} designed a ${spec.venue === "direct" ? "direct on chain" : "Pons"} launch: ${spec.name} ($${spec.symbol})`,
    detail: `LAURA says: "${spec.message}" · ${econ} · ${spec.concept}`,
    refId: launch.id,
  });
  try {
    await ensureLaunchArt(launch.id, { name: launch.name, symbol: launch.symbol, motif: launch.artMotif, palette: launch.artPalette, style: launch.artStyle, imageQuery: launch.imageQuery });
  } catch {
    /* art regenerates on demand */
  }
  return launch;
}

async function patch(id: string, fn: (l: DirectLaunch) => void): Promise<DirectLaunch | null> {
  return updateState((state) => {
    const l = (state.directLaunches ?? []).find((x) => x.id === id);
    if (!l) return null;
    fn(l);
    return l;
  });
}

async function deployOne(launch: DirectLaunch): Promise<{ ok: true } | { ok: false; error: string }> {
  await patch(launch.id, (l) => {
    l.status = "deploying";
    l.error = null;
  });
  const done = beginChainWork(`direct:${launch.id}`);
  try {
    if (launch.venue === "pons") {
      const res = await launchOnPons(launch, directLaunchImageUrl(launch.id), PUBLIC_SITE);
      const page = ponsTokenUrl(res.token);
      await updateState((state) => {
        const l = (state.directLaunches ?? []).find((x) => x.id === launch.id);
        if (!l) return;
        l.status = "deployed";
        l.txHash = res.txHash;
        l.tokenAddress = res.token;
        l.poolAddress = res.curve;
        l.devBuyTxHash = res.devBuyTxHash;
        l.deployedAt = Date.now();
        l.costEth = res.costEth;
        l.pageUrl = page;
        l.verifiedAt = Date.now();
        pushEvent(state, {
          kind: "direct.deployed",
          agentId: "system",
          title: `Launched ${l.name} ($${l.symbol}) on Pons`,
          detail: `Token ${res.token}, curve ${res.curve}, creator tax ${l.creatorTaxBps / 100}% to LAURA's wallet${res.devBuyTxHash ? `, opening buy ${l.devBuyEth} ETH` : ""}. ${page}`,
          refId: l.id,
        });
      });
      return { ok: true };
    }
    const res = await deployDirectLaunch(launch, log, async (p) => {
      await patch(launch.id, (l) => {
        if (p.token) l.tokenAddress = p.token;
        if (p.txHash) l.txHash = p.txHash;
        if (p.pool) l.poolAddress = p.pool;
        if (p.lpTokenId) l.lpTokenId = p.lpTokenId;
        if (p.token) {
          l.deployedAt = Date.now();
          l.pageUrl = explorerTokenUrl("weth", p.token);
        }
      });
    });
    const page = explorerTokenUrl("weth", res.token);
    await updateState((state) => {
      const l = (state.directLaunches ?? []).find((x) => x.id === launch.id);
      if (!l) return;
      l.status = "deployed";
      l.txHash = res.txHash;
      l.tokenAddress = res.token;
      l.poolAddress = res.pool;
      l.lpTokenId = res.lpTokenId;
      l.deployedAt = Date.now();
      l.costEth = res.costEth;
      l.pageUrl = page;
      pushEvent(state, {
        kind: "direct.deployed",
        agentId: "system",
        title: `Deployed ${l.name} ($${l.symbol}) straight on chain`,
        detail: `Token ${res.token}, vDEX pool ${res.pool} seeded single sided (position #${res.lpTokenId}, ticks ${res.tickLower}..${res.tickUpper}), admin key burned. Buy tax ${l.startTaxBps} to ${l.floorTaxBps} bps, ${l.holderShareBps / 100}% to holders (${l.rewardMode}), ${l.burnShareBps / 100}% burned. ${page}`,
        refId: l.id,
      });
    });
    return { ok: true };
  } catch (err) {
    const error = String(err).slice(0, 400);
    await updateState((state) => {
      const l = (state.directLaunches ?? []).find((x) => x.id === launch.id);
      if (!l) return;
      /* A token that got as far as an address stays "deployed" with the error on the record; nothing else failed. */
      l.status = l.tokenAddress ? "deployed" : "approved";
      l.error = error;
      pushEvent(state, { kind: "direct.failed", agentId: "system", title: `Direct launch of ${l.name} ($${l.symbol}) failed`, detail: error, refId: l.id });
    });
    return { ok: false, error };
  } finally {
    done();
  }
}

async function verifyOne(launch: DirectLaunch): Promise<boolean> {
  if (!launch.tokenAddress) return false;
  const already = await checkVerified(launch.tokenAddress);
  if (already.verified) {
    await updateState((state) => {
      const l = (state.directLaunches ?? []).find((x) => x.id === launch.id);
      if (!l) return;
      l.verifiedAt = Date.now();
      pushEvent(state, { kind: "direct.verified", agentId: "system", title: `Source verified for ${l.name} ($${l.symbol})`, detail: `${already.detail} (${already.via}). Read and Write tabs are live for everyone: ${l.pageUrl ?? l.tokenAddress}`, refId: l.id });
    });
    return true;
  }
  const outcome = await submitVerification({ contractAddress: launch.tokenAddress, source: TAX_TOKEN_SOURCE, contractName: TAX_TOKEN_CONTRACT_NAME, txHash: launch.txHash });
  await patch(launch.id, (l) => {
    l.verifyAttempts += 1;
  });
  log(`verify: ${launch.symbol} submitted to ${outcome.submitted.join(", ") || "nobody"}${outcome.errors.length ? ` (${outcome.errors.join("; ").slice(0, 200)})` : ""}`);
  return false;
}

async function reconcileOrphans(state: SwarmState): Promise<void> {
  const now = Date.now();
  for (const l of state.directLaunches ?? []) {
    if (l.status !== "deploying" || chainWorkOpen(`direct:${l.id}`)) continue;
    if (now - (l.createdAt ?? 0) < ORPHAN_AFTER_MS && now - (l.reviewedAt ?? 0) < ORPHAN_AFTER_MS) continue;
    /* The process that was deploying is gone. Without an address nothing is known to be on chain; the spec waits for a retry. */
    l.status = l.tokenAddress ? "deployed" : "approved";
    l.error = `Deploy interrupted by a process restart; ${l.tokenAddress ? "token exists, later steps may be missing" : "no token recorded, will retry"}`;
    pushEvent(state, { kind: "direct.failed", agentId: "system", title: `Direct launch ${l.name} ($${l.symbol}) interrupted`, detail: l.error, refId: l.id });
  }
  await saveState(state);
}

/** True when the scheduler should spend a tick on this executor. */
export function directLaunchWork(state: SwarmState): boolean {
  return (state.directLaunches ?? []).some(
    (l) => l.status === "approved" || l.status === "deploying" || (l.status === "deployed" && l.venue === "direct" && !l.verifiedAt && l.verifyAttempts < MAX_VERIFY_ATTEMPTS),
  );
}

export async function runDirectLaunchExecutor(): Promise<void> {
  const es = execState();
  if (es.running) return;
  es.running = true;
  try {
    let state = await loadState();
    if (!state.settings.autoExecuteLaunches) return;
    if ((state.directLaunches ?? []).some((l) => l.status === "deploying")) {
      await reconcileOrphans(state);
      state = await loadState();
    }
    const now = Date.now();
    const unverified = (state.directLaunches ?? []).filter(
      (l) => l.status === "deployed" && l.venue === "direct" && l.tokenAddress && !l.verifiedAt && l.verifyAttempts < MAX_VERIFY_ATTEMPTS && (es.nextAttemptAt[`verify:${l.id}`] ?? 0) <= now,
    );
    for (const l of unverified) {
      try {
        const ok = await verifyOne(l);
        if (ok) delete es.nextAttemptAt[`verify:${l.id}`];
        else es.nextAttemptAt[`verify:${l.id}`] = now + VERIFY_BACKOFF_MS;
      } catch (err) {
        es.nextAttemptAt[`verify:${l.id}`] = now + VERIFY_BACKOFF_MS;
        log(`verify: ${l.symbol} check failed (${String(err).slice(0, 160)}); retrying in 10m`);
      }
    }

    const queue = queuedDirectLaunches(state)
      .filter((l) => l.status === "approved" && (es.nextAttemptAt[l.id] ?? 0) <= now)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt);
    if (queue.length === 0) return;

    const wallet = await walletStatus();
    if (!wallet.configured || !wallet.funded) return;
    if ((wallet.balanceEth ?? 0) - DIRECT_LAUNCH_CAPS.maxEthPerLaunch < DIRECT_LAUNCH_CAPS.treasuryFloorEth) return;

    const capacity = directCapacity(state.directLaunches ?? [], now);
    if (!capacity.open) {
      if (es.lastWindowNote !== capacity.nextWindowAt) {
        es.lastWindowNote = capacity.nextWindowAt;
        log(`autonomy: ${queue.length} direct spec(s) queued (${queue[0].symbol} next); ${capacity.reason}`);
      }
      return;
    }
    const next = queue[0];
    log(`autonomy: launching ${next.name} ($${next.symbol}) on the ${next.venue} rail`);
    const result = await deployOne(next);
    if (result.ok) {
      delete es.nextAttemptAt[next.id];
      log(`autonomy: ${next.symbol} is live on the ${next.venue} rail`);
    } else {
      es.nextAttemptAt[next.id] = now + RETRY_BACKOFF_MS;
      log(`autonomy: ${next.symbol} failed (${result.error.slice(0, 200)}); retrying in 20m`);
    }
  } catch (err) {
    log(`executor error: ${String(err)}`);
  } finally {
    es.running = false;
  }
}
