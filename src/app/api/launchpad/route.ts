import { NextResponse } from "next/server";
import { loadState } from "@/lib/store";
import { LAUNCHPAD } from "@/lib/launchpad/contracts";
import { LAUNCH_CAPS, launcherGrid, padState, walletStatus } from "@/lib/launchpad/service";

export const dynamic = "force-dynamic";

/** Launchpad context for the console: wallet, live pad state, and the public floor. */
export async function GET() {
  const [wallet, pad, grid, state] = await Promise.all([
    walletStatus(),
    padState("weth").catch(() => null),
    launcherGrid("new", 10).catch(() => []),
    loadState(),
  ]);
  return NextResponse.json({
    wallet,
    pad,
    grid,
    caps: LAUNCH_CAPS,
    explorer: LAUNCHPAD.explorer,
    factory: LAUNCHPAD.factory,
    autoExecute: state.settings.autoExecuteLaunches,
  });
}
