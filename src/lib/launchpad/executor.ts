import { loadState, pushEvent, saveState, updateState } from "@/lib/store";
import type { LaunchProposal, SwarmState } from "@/lib/types";
import { beginChainWork, chainWorkOpen } from "@/lib/chain-work";
import { explainPadError } from "@/lib/launchpad/contracts";
import {
  LAUNCH_CAPS,
  armLaunch,
  deployLaunch,
  findOrphanDeploy,
  getAccount,
  normalizeTaxDecay,
  verifyLaunchVisible,
  walletStatus,
} from "@/lib/launchpad/service";
import { ensureLaunchArt } from "@/lib/launchpad/art";
import { deployCapacity } from "@/lib/launchpad/capacity";
import { laneClosedReason } from "@/lib/launchpad/lanes";
import { reservedLaunchNameHit } from "@/lib/launchpad/spec";
import {
  attachTokenLogo,
  attachTokenProfile,
  profileLinksFromEnv,
  uploadTokenImage,
} from "@/lib/launchpad/images";

/**
 * Launch execution: deploy + brand a spec in one motion.
 * Used by the operator's Deploy button and by the autonomous executor
 * the scheduler runs each tick. Every path fails closed on the same
 * hard rails: funded designated wallet above the wallet floor, spend/deploy,
 * pacing between deploys (no daily count cap), live pad bounds (re-validated
 * inside deployLaunch).
 */

function log(msg: string): void {
  console.log(`[launch-exec ${new Date().toISOString()}] ${msg}`);
}

export type ExecuteResult =
  | { ok: true; launch: LaunchProposal }
  | { ok: false; error: string; httpStatus: number };

/** Deploys one approved launch, then uploads its logo and attaches links. */
export async function executeLaunch(id: string): Promise<ExecuteResult> {
  const state = await loadState();
  const launch = state.launches.find((l) => l.id === id);
  if (!launch) return { ok: false, error: "Launch not found", httpStatus: 404 };
  if (launch.status !== "approved")
    return { ok: false, error: "Only approved launches can deploy", httpStatus: 409 };
  const laneClosed = laneClosedReason(launch.lane);
  if (laneClosed) return { ok: false, error: laneClosed, httpStatus: 409 };

  const wallet = await walletStatus();
  if (!wallet.configured)
    return {
      ok: false,
      error: "No swarm wallet configured. Set SWARM_WALLET_PRIVATE_KEY and restart.",
      httpStatus: 409,
    };
  if (!wallet.funded)
    return {
      ok: false,
      error: `Swarm wallet ${wallet.address} is not funded yet (balance ${wallet.balanceEth ?? "unknown"} ETH).`,
      httpStatus: 409,
    };
  /* Wallet floor: a deploy may never take the balance under the floor that
     keeps gas for treasury ops and fee claims. Count is unlimited; ETH is not. */
  if ((wallet.balanceEth ?? 0) - LAUNCH_CAPS.maxSpendEthPerDeploy < LAUNCH_CAPS.walletFloorEth)
    return {
      ok: false,
      error: `Wallet floor: ${(wallet.balanceEth ?? 0).toFixed(4)} ETH minus the ${LAUNCH_CAPS.maxSpendEthPerDeploy} ETH deploy budget would breach the ${LAUNCH_CAPS.walletFloorEth} ETH floor`,
      httpStatus: 409,
    };
  const capacity = deployCapacity(state.launches);
  if (!capacity.open)
    return {
      ok: false,
      error: capacity.reason ?? `Pacing: launches go out at least ${LAUNCH_CAPS.minDeployGapMinutes} min apart`,
      httpStatus: 429,
    };

  /* Pad economics rule: snap the tax decay onto what the pads accept (exact
     multiple, 10-99 min window) instead of burning a deploy attempt on
     BadEconomics(). The adjustment is recorded on the launch so the readback
     is honest about what changed. */
  const snapped = normalizeTaxDecay(launch.startTaxBps, launch.taxDecayPerMinuteBps);
  if (snapped.startTaxBps !== launch.startTaxBps || snapped.taxDecayPerMinuteBps !== launch.taxDecayPerMinuteBps) {
    const before = `${launch.startTaxBps} bps decaying ${launch.taxDecayPerMinuteBps}/min (${(launch.startTaxBps / Math.max(1, launch.taxDecayPerMinuteBps)).toFixed(1)} min)`;
    const after = `${snapped.startTaxBps} bps decaying ${snapped.taxDecayPerMinuteBps}/min (${snapped.startTaxBps / snapped.taxDecayPerMinuteBps} min)`;
    launch.startTaxBps = snapped.startTaxBps;
    launch.taxDecayPerMinuteBps = snapped.taxDecayPerMinuteBps;
    launch.error = `Tax decay adjusted to the pad rule before deploy: ${before} → ${after}. The pads require the start tax to be an exact multiple of the decay with a 10-99 minute window.`;
    log(`autonomy: ${launch.symbol} tax decay snapped to the pad rule: ${before} → ${after}`);
  }

  launch.status = "deploying";
  await saveState(state);

  /* Open from the moment the tx may be sent until the record is written:
     /api/health reports busy and the shutdown handler waits on this. */
  const doneChainWork = beginChainWork(`launch:${launch.id}`);
  try {
    const result = await deployLaunch(launch);

    /* Arm immediately: load the supply and start the sale clock. Without this
       the launch sits registered-but-dead ("waiting", startTime 0) forever —
       learned the hard way with launches #276/#277. Non-fatal on failure: the
       executor's repair pass re-arms deployed-but-unarmed launches each tick. */
    let armedAt: number | null = null;
    let armTxHash: string | null = null;
    let armNote = "";
    try {
      const arm = await armLaunch({
        ...launch,
        launchId: result.launchId,
        tokenAddress: result.tokenAddress,
      });
      armedAt = Date.now();
      armTxHash = arm.armTxHash || null;
    } catch (err) {
      armNote = `Created but NOT armed yet (supply not loaded): ${String(err)}`;
      log(`arm failed for ${launch.symbol}: ${String(err)}`);
    }

    /* Brand the token: procedural logo + community links. Non-fatal if the
       launcher API hiccups — the deploy already stands on-chain. */
    let imageHash: string | null = null;
    let brandingNote = "";
    if (result.tokenAddress) {
      const branded = await brandLaunch(launch, result.tokenAddress);
      imageHash = branded.imageHash;
      brandingNote = branded.note ? ` · ${branded.note}` : "";
    }

    /* Verify the USER-VISIBLE end state: the token must render on the surface
       the Stonklauncher UI reads (floor phase "live"), not just return a good
       receipt. Operator caught launches #276/#277 "deployed" but invisible —
       they sat unarmed in the Waiting pile for 30 minutes. Non-fatal here:
       the executor's verify pass re-checks unverified launches each tick. */
    let verifiedAt: number | null = null;
    let verifyDetail = "";
    if (armedAt && result.tokenAddress) {
      try {
        const vis = await verifyLaunchVisible(result.tokenAddress);
        verifyDetail = vis.detail;
        if (vis.visible) verifiedAt = Date.now();
      } catch (err) {
        verifyDetail = `verify failed: ${String(err)}`;
      }
    }

    const updated = await updateState((s) => {
      const l = s.launches.find((x) => x.id === id);
      if (!l) return null;
      l.status = "deployed";
      l.txHash = result.txHash;
      l.tokenAddress = result.tokenAddress;
      l.launchId = result.launchId;
      l.deployedAt = Date.now();
      l.armedAt = armedAt;
      l.armTxHash = armTxHash;
      l.imageHash = imageHash;
      l.verifiedAt = verifiedAt;
      const notes = [armNote, brandingNote ? brandingNote.slice(3) : ""].filter(Boolean);
      l.error = notes.length ? notes.join(" · ") : null;
      const agent = s.agents.find((a) => a.id === "mint");
      if (agent) agent.stats.published += 1;
      pushEvent(s, {
        kind: "launch.deployed",
        agentId: s.settings.autoExecuteLaunches ? "system" : "operator",
        title: `Deployed ${l.name} ($${l.symbol}) on Smart Launch V2`,
        detail: `token ${result.tokenAddress ?? "?"} · launch #${result.launchId ?? "?"} · tx ${result.txHash}${armedAt ? " · armed (sale clock running)" : " · ARM PENDING"}${imageHash ? " · logo attached" : brandingNote}`,
        refId: l.id,
      });
      if (verifiedAt) {
        pushEvent(s, {
          kind: "launch.verified",
          agentId: "system",
          title: `Verified ${l.name} ($${l.symbol}) visible on the Stonklauncher UI`,
          detail: verifyDetail,
          refId: l.id,
        });
      }
      return l;
    });
    if (!updated) return { ok: false, error: "Launch vanished during deploy", httpStatus: 500 };
    return { ok: true, launch: updated };
  } catch (err) {
    await updateState((s) => {
      const l = s.launches.find((x) => x.id === id);
      if (!l) return;
      l.status = "approved"; // return to approved so it can retry
      l.error = explainPadError(err);
      pushEvent(s, {
        kind: "launch.failed",
        agentId: "system",
        title: `Deploy failed: ${l.name} ($${l.symbol})`,
        detail: explainPadError(err),
        refId: l.id,
      });
    });
    log(`deploy error detail: ${String(err).split("\n").slice(0, 3).join(" / ").slice(0, 400)}`);
    return { ok: false, error: explainPadError(err), httpStatus: 502 };
  } finally {
    doneChainWork();
  }
}

/** Procedural logo + community links on the launcher; never throws. */
async function brandLaunch(
  launch: LaunchProposal,
  tokenAddress: string,
): Promise<{ imageHash: string | null; note: string }> {
  try {
    const account = getAccount();
    if (!account) throw new Error("wallet unavailable for signing");
    const art = await ensureLaunchArt(launch.id, {
      name: launch.name,
      symbol: launch.symbol,
      motif: launch.artMotif,
      palette: launch.artPalette,
      style: launch.artStyle,
    });
    const imageHash = await uploadTokenImage(art);
    await attachTokenLogo(account, tokenAddress, imageHash);
    const links = profileLinksFromEnv();
    if (links) await attachTokenProfile(account, tokenAddress, links);
    return { imageHash, note: "" };
  } catch (err) {
    log(`branding failed for ${launch.symbol}: ${String(err)}`);
    return { imageHash: null, note: `logo attach failed: ${String(err)}` };
  }
}

/**
 * A record can only stay in "deploying" across a process death (the deploy
 * itself is synchronous inside one process and marks its chain work). For
 * each such orphan: if the pad shows a launch by our wallet with this token's
 * name and symbol, the tx was mined and only the bookkeeping was lost —
 * record it as deployed (the arm/brand/verify passes then finish the job);
 * otherwise the tx never went out and the spec returns to the queue.
 */
async function reconcileOrphanDeploys(state: SwarmState): Promise<void> {
  const orphans = state.launches.filter((l) => l.status === "deploying" && !chainWorkOpen(`launch:${l.id}`));
  if (orphans.length === 0) return;
  const known = new Set(state.launches.map((l) => l.tokenAddress).filter((t): t is string => !!t));
  for (const orphan of orphans) {
    let found: Awaited<ReturnType<typeof findOrphanDeploy>> = null;
    try {
      found = await findOrphanDeploy(orphan.lane, { name: orphan.name, symbol: orphan.symbol }, known);
    } catch (err) {
      log(`reconcile: pad lookup for ${orphan.symbol} failed (${String(err)}); will retry next tick`);
      continue;
    }
    if (found) {
      known.add(found.tokenAddress);
      const branded = await brandLaunch(orphan, found.tokenAddress);
      await updateState((s) => {
        const l = s.launches.find((x) => x.id === orphan.id);
        if (!l) return;
        l.status = "deployed";
        l.tokenAddress = found.tokenAddress;
        l.launchId = found.launchId;
        l.deployedAt = l.deployedAt ?? Date.now();
        l.armedAt = found.armed ? Date.now() : null;
        l.imageHash = branded.imageHash;
        l.error = `Recovered: the process was restarted mid-deploy; the on-chain launch (#${found.launchId}) was found on the pad and re-attached. tx hash not recorded.${branded.note ? ` · ${branded.note}` : ""}`;
        const agent = s.agents.find((a) => a.id === "mint");
        if (agent) agent.stats.published += 1;
        pushEvent(s, {
          kind: "launch.deployed",
          agentId: "system",
          title: `Deployed ${l.name} ($${l.symbol}) on Smart Launch V2 (recovered after restart)`,
          detail: `token ${found.tokenAddress} · launch #${found.launchId} · the deploy tx was mined while the process restarted; record reconciled from the pad${found.armed ? " · armed" : " · ARM PENDING"}${branded.imageHash ? " · logo attached" : ""}`,
          refId: l.id,
        });
      });
      log(`reconcile: ${orphan.symbol} found on the ${orphan.lane} pad as launch #${found.launchId} (${found.tokenAddress}); recorded as deployed`);
    } else {
      await updateState((s) => {
        const l = s.launches.find((x) => x.id === orphan.id);
        if (!l) return;
        l.status = "approved";
        l.error = "Process restarted mid-deploy before any transaction landed; returned to the queue.";
      });
      log(`reconcile: ${orphan.symbol} not on the pad; returned to the queue`);
    }
  }
}

/* --------------------- Autonomous queue executor --------------------- */

declare global {
  var __lauraLaunchExecutor:
    | { running: boolean; nextAttemptAt: Record<string, number>; lastWindowNote?: number }
    | undefined;
}

function execState() {
  if (!globalThis.__lauraLaunchExecutor) {
    globalThis.__lauraLaunchExecutor = { running: false, nextAttemptAt: {}, lastWindowNote: 0 };
  }
  return globalThis.__lauraLaunchExecutor;
}

const RETRY_BACKOFF_MS = 15 * 60_000;
/** Floor indexing usually lands within a minute of arm; re-check gently. */
const VERIFY_BACKOFF_MS = 5 * 60_000;

/** Arms one deployed-but-unarmed launch: loads supply, starts the clock, records it. */
async function repairUnarmedLaunch(launch: LaunchProposal): Promise<void> {
  log(`repair: arming ${launch.name} ($${launch.symbol}) — launch #${launch.launchId}`);
  const done = beginChainWork(`arm:${launch.id}`);
  try {
    await armAndRecord(launch);
  } finally {
    done();
  }
}

async function armAndRecord(launch: LaunchProposal): Promise<void> {
  const arm = await armLaunch(launch);
  await updateState((s) => {
    const l = s.launches.find((x) => x.id === launch.id);
    if (!l) return;
    l.armedAt = Date.now();
    l.armTxHash = arm.armTxHash || null;
    l.error = null;
    pushEvent(s, {
      kind: "launch.armed",
      agentId: "system",
      title: `Armed ${l.name} ($${l.symbol}) — supply loaded, sale clock running`,
      detail: arm.alreadyArmed
        ? "Pad already reported the launch armed; recorded it."
        : `arm tx ${arm.armTxHash}`,
      refId: l.id,
    });
  });
  log(`repair: armed ${launch.symbol}${arm.alreadyArmed ? " (was already armed on pad)" : ""}`);
}

/** Confirms an armed launch renders on the Stonklauncher UI and records the proof. */
async function verifyDeployedLaunch(launch: LaunchProposal): Promise<boolean> {
  if (!launch.tokenAddress) return false;
  const vis = await verifyLaunchVisible(launch.tokenAddress);
  if (!vis.visible) {
    log(`verify: ${launch.symbol} not user-visible yet (${vis.detail})`);
    return false;
  }
  await updateState((s) => {
    const l = s.launches.find((x) => x.id === launch.id);
    if (!l || l.verifiedAt) return;
    l.verifiedAt = Date.now();
    pushEvent(s, {
      kind: "launch.verified",
      agentId: "system",
      title: `Verified ${l.name} ($${l.symbol}) visible on the Stonklauncher UI`,
      detail: vis.detail,
      refId: l.id,
    });
  });
  log(`verify: ${launch.symbol} confirmed on the launcher UI (${vis.detail})`);
  return true;
}

/**
 * Runs the launch queue when full autonomy is on. Called by the scheduler
 * every tick. Order of work: (1) repair pass — arm any deployed launch whose
 * supply never loaded, (2) verify pass — confirm armed launches actually
 * render on the Stonklauncher UI, (3) deploy at most one approved spec, so a
 * bad spec can never drain the wallet in a burst. Failures back off 15 minutes.
 */
export async function runLaunchExecutor(): Promise<void> {
  const es = execState();
  if (es.running) return;
  es.running = true;
  try {
    let state = await loadState();
    if (!state.settings.autoExecuteLaunches) return;

    if (state.launches.some((l) => l.status === "deploying")) {
      await reconcileOrphanDeploys(state);
      state = await loadState();
    }

    const now = Date.now();
    const unarmed = state.launches.filter(
      (l) =>
        l.status === "deployed" &&
        l.tokenAddress &&
        l.launchId &&
        !l.armedAt &&
        (es.nextAttemptAt[`arm:${l.id}`] ?? 0) <= now,
    );
    /* Launches whose name trips the floor's reserved brand filter deploy and
       trade fine but can never index (learned with CLKIN #281), so retrying
       their visibility check forever is pure waste: skip them. */
    const unverified = state.launches.filter(
      (l) =>
        l.status === "deployed" &&
        l.tokenAddress &&
        l.armedAt &&
        !l.verifiedAt &&
        !reservedLaunchNameHit(l.name, l.symbol) &&
        (es.nextAttemptAt[`verify:${l.id}`] ?? 0) <= now,
    );
    /* Weekend-closed stock lanes stay queued (not failed) and deploy on the
       first tick after the lane reopens Monday 00:15 UTC. */
    const queue = state.launches
      .filter(
        (l) =>
          l.status === "approved" &&
          (es.nextAttemptAt[l.id] ?? 0) <= now &&
          laneClosedReason(l.lane) === null,
      )
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt);
    if (unarmed.length === 0 && unverified.length === 0 && queue.length === 0) return;

    for (const launch of unverified) {
      try {
        const ok = await verifyDeployedLaunch(launch);
        if (ok) delete es.nextAttemptAt[`verify:${launch.id}`];
        else es.nextAttemptAt[`verify:${launch.id}`] = now + VERIFY_BACKOFF_MS;
      } catch (err) {
        es.nextAttemptAt[`verify:${launch.id}`] = now + VERIFY_BACKOFF_MS;
        log(`verify: check of ${launch.symbol} failed (${String(err)}); retrying in 5m`);
      }
    }
    if (unarmed.length === 0 && queue.length === 0) return;

    const wallet = await walletStatus();
    if (!wallet.configured || !wallet.funded) return; // queue holds until funding lands

    for (const launch of unarmed) {
      try {
        await repairUnarmedLaunch(launch);
        delete es.nextAttemptAt[`arm:${launch.id}`];
      } catch (err) {
        es.nextAttemptAt[`arm:${launch.id}`] = now + RETRY_BACKOFF_MS;
        log(`repair: arm of ${launch.symbol} failed (${String(err)}); retrying in 15m`);
      }
    }

    if (queue.length === 0) return;
    const capacity = deployCapacity(state.launches, now);
    if (!capacity.open) {
      /* One line per window change, not per tick: the queue is healthy, it is waiting. */
      if (es.lastWindowNote !== capacity.nextWindowAt) {
        es.lastWindowNote = capacity.nextWindowAt;
        log(`autonomy: ${queue.length} spec(s) queued (${queue[0].symbol} next) — ${capacity.reason}`);
      }
      return;
    }

    const next = queue[0];
    log(`autonomy: deploying ${next.name} ($${next.symbol})`);
    const result = await executeLaunch(next.id);
    if (result.ok) {
      delete es.nextAttemptAt[next.id];
      log(`autonomy: deployed ${next.symbol} at ${result.launch.tokenAddress ?? "?"}`);
    } else {
      es.nextAttemptAt[next.id] = now + RETRY_BACKOFF_MS;
      log(`autonomy: deploy of ${next.symbol} failed (${result.error}); retrying in 15m`);
    }
  } catch (err) {
    log(`executor error: ${String(err)}`);
  } finally {
    es.running = false;
  }
}
