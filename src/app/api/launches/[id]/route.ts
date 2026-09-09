import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { loadState, pushEvent, saveState, updateState } from "@/lib/store";
import { LAUNCH_CAPS, deployLaunch, walletStatus } from "@/lib/launchpad/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["approve", "reject", "deploy"]),
  reviewerNote: z.string().max(500).optional(),
});

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/launches/[id]">) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const { action, reviewerNote } = parsed.data;

  if (action !== "deploy") {
    const result = await updateState((state) => {
      const launch = state.launches.find((l) => l.id === id);
      if (!launch) return null;
      if (launch.status !== "pending" && launch.status !== "approved") return { error: `Cannot ${action} a ${launch.status} launch` };
      launch.status = action === "approve" ? "approved" : "rejected";
      launch.reviewedAt = Date.now();
      launch.reviewerNote = reviewerNote ?? null;
      const agent = state.agents.find((a) => a.id === "mint");
      if (agent) {
        if (action === "approve") agent.stats.approved += 1;
        else agent.stats.rejected += 1;
      }
      pushEvent(state, {
        kind: action === "approve" ? "launch.approved" : "launch.rejected",
        agentId: "operator",
        title: `${action === "approve" ? "Approved" : "Rejected"} launch: ${launch.name} ($${launch.symbol})`,
        detail: reviewerNote ?? launch.concept,
        refId: launch.id,
      });
      return launch;
    });
    if (!result) return NextResponse.json({ error: "Launch not found" }, { status: 404 });
    if ("error" in result) return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result);
  }

  /* Deploy: fail-closed checks, then on-chain createLaunch */
  const state = await loadState();
  const launch = state.launches.find((l) => l.id === id);
  if (!launch) return NextResponse.json({ error: "Launch not found" }, { status: 404 });
  if (launch.status !== "approved")
    return NextResponse.json({ error: "Only operator-approved launches can deploy" }, { status: 409 });

  const wallet = await walletStatus();
  if (!wallet.configured)
    return NextResponse.json(
      { error: "No swarm wallet configured. Set SWARM_WALLET_PRIVATE_KEY and restart." },
      { status: 409 },
    );
  if (!wallet.funded)
    return NextResponse.json(
      { error: `Swarm wallet ${wallet.address} is not funded yet (balance ${wallet.balanceEth ?? "unknown"} ETH).` },
      { status: 409 },
    );

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const deploysToday = state.launches.filter((l) => l.status === "deployed" && (l.deployedAt ?? 0) > dayAgo).length;
  if (deploysToday >= LAUNCH_CAPS.maxDeploysPerDay)
    return NextResponse.json(
      { error: `Daily cap reached: ${LAUNCH_CAPS.maxDeploysPerDay} deploys per 24h` },
      { status: 429 },
    );

  launch.status = "deploying";
  await saveState(state);

  try {
    const result = await deployLaunch(launch);
    const updated = await updateState((s) => {
      const l = s.launches.find((x) => x.id === id);
      if (!l) return null;
      l.status = "deployed";
      l.txHash = result.txHash;
      l.tokenAddress = result.tokenAddress;
      l.launchId = result.launchId;
      l.deployedAt = Date.now();
      l.error = null;
      const agent = s.agents.find((a) => a.id === "mint");
      if (agent) agent.stats.published += 1;
      pushEvent(s, {
        kind: "launch.deployed",
        agentId: "operator",
        title: `Deployed ${l.name} ($${l.symbol}) on Smart Launch V2`,
        detail: `token ${result.tokenAddress ?? "?"} · launch #${result.launchId ?? "?"} · tx ${result.txHash}`,
        refId: l.id,
      });
      return l;
    });
    return NextResponse.json(updated);
  } catch (err) {
    const updated = await updateState((s) => {
      const l = s.launches.find((x) => x.id === id);
      if (!l) return null;
      l.status = "approved"; // return to approved so the operator can retry
      l.error = String(err);
      pushEvent(s, {
        kind: "launch.failed",
        agentId: "system",
        title: `Deploy failed: ${l.name} ($${l.symbol})`,
        detail: String(err),
        refId: l.id,
      });
      return l;
    });
    return NextResponse.json({ error: String(err), launch: updated }, { status: 502 });
  }
}
