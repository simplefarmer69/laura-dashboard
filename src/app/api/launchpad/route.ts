import { NextResponse } from "next/server";
import { LAUNCHPAD } from "@/lib/launchpad/contracts";
import { LAUNCH_CAPS, launcherGrid, padState, walletStatus } from "@/lib/launchpad/service";

export const dynamic = "force-dynamic";

/** Launchpad context for the console: wallet, live pad state, and the public floor. */
export async function GET() {
  const [wallet, pad, grid] = await Promise.all([
    walletStatus(),
    padState("weth").catch(() => null),
    launcherGrid("new", 10).catch(() => []),
  ]);
  return NextResponse.json({
    wallet,
    pad,
    grid,
    caps: LAUNCH_CAPS,
    explorer: LAUNCHPAD.explorer,
    factory: LAUNCHPAD.factory,
  });
}
