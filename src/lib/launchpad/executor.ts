import { loadState, pushEvent, saveState, updateState } from "@/lib/store";
import type { LaunchProposal } from "@/lib/types";
import { LAUNCH_CAPS, armLaunch, deployLaunch, getAccount, walletStatus } from "@/lib/launchpad/service";
import { ensureLaunchArt } from "@/lib/launchpad/art";
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
 * hard caps: funded designated wallet, deploys/day, spend/deploy,
 * live pad bounds (re-validated inside deployLaunch).
 */

function log(msg: string): void {
  console.log(`[launch-exec ${new Date().toISOString()}] ${msg}`);
}

function deploysInLast24h(launches: LaunchProposal[]): number {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  return launches.filter((l) => l.status === "deployed" && (l.deployedAt ?? 0) > dayAgo).length;
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
  if (deploysInLast24h(state.launches) >= LAUNCH_CAPS.maxDeploysPerDay)
    return {
      ok: false,
      error: `Daily cap reached: ${LAUNCH_CAPS.maxDeploysPerDay} deploys per 24h`,
      httpStatus: 429,
    };

  launch.status = "deploying";
  await saveState(state);

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
      try {
        const account = getAccount();
        if (!account) throw new Error("wallet unavailable for signing");
        const art = await ensureLaunchArt(launch.id, {
          name: launch.name,
          symbol: launch.symbol,
          motif: launch.artMotif,
          palette: launch.artPalette,
        });
        imageHash = await uploadTokenImage(art);
        await attachTokenLogo(account, result.tokenAddress, imageHash);
        const links = profileLinksFromEnv();
        if (links) await attachTokenProfile(account, result.tokenAddress, links);
      } catch (err) {
        brandingNote = ` · logo attach failed: ${String(err)}`;
        log(`branding failed for ${launch.symbol}: ${String(err)}`);
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
      return l;
    });
    if (!updated) return { ok: false, error: "Launch vanished during deploy", httpStatus: 500 };
    return { ok: true, launch: updated };
  } catch (err) {
    await updateState((s) => {
      const l = s.launches.find((x) => x.id === id);
      if (!l) return;
      l.status = "approved"; // return to approved so it can retry
      l.error = String(err);
      pushEvent(s, {
        kind: "launch.failed",
        agentId: "system",
        title: `Deploy failed: ${l.name} ($${l.symbol})`,
        detail: String(err),
        refId: l.id,
      });
    });
    return { ok: false, error: String(err), httpStatus: 502 };
  }
}

/* --------------------- Autonomous queue executor --------------------- */

declare global {
  var __lauraLaunchExecutor: { running: boolean; nextAttemptAt: Record<string, number> } | undefined;
}

function execState() {
  if (!globalThis.__lauraLaunchExecutor) {
    globalThis.__lauraLaunchExecutor = { running: false, nextAttemptAt: {} };
  }
  return globalThis.__lauraLaunchExecutor;
}

const RETRY_BACKOFF_MS = 15 * 60_000;

/** Arms one deployed-but-unarmed launch: loads supply, starts the clock, records it. */
async function repairUnarmedLaunch(launch: LaunchProposal): Promise<void> {
  log(`repair: arming ${launch.name} ($${launch.symbol}) — launch #${launch.launchId}`);
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

/**
 * Runs the launch queue when full autonomy is on. Called by the scheduler
 * every tick. Order of work: (1) repair pass — arm any deployed launch whose
 * supply never loaded, (2) deploy at most one approved spec, so a bad spec
 * can never drain the wallet in a burst. Failures back off 15 minutes.
 */
export async function runLaunchExecutor(): Promise<void> {
  const es = execState();
  if (es.running) return;
  es.running = true;
  try {
    const state = await loadState();
    if (!state.settings.autoExecuteLaunches) return;

    const now = Date.now();
    const unarmed = state.launches.filter(
      (l) =>
        l.status === "deployed" &&
        l.tokenAddress &&
        l.launchId &&
        !l.armedAt &&
        (es.nextAttemptAt[`arm:${l.id}`] ?? 0) <= now,
    );
    const queue = state.launches
      .filter((l) => l.status === "approved" && (es.nextAttemptAt[l.id] ?? 0) <= now)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt);
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
    if (deploysInLast24h(state.launches) >= LAUNCH_CAPS.maxDeploysPerDay) return;

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
