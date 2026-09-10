import { NextResponse } from "next/server";
import { isViewerMode } from "@/lib/viewer/mode";
import { readSnapshot } from "@/lib/viewer/store";
import { loadState } from "@/lib/store";
import { LAUNCHPAD } from "@/lib/launchpad/contracts";
import { LAUNCH_CAPS, launcherGrid, padState, walletStatus } from "@/lib/launchpad/service";

export const dynamic = "force-dynamic";

/** Launchpad context for the console: wallet, live pad state, and the public floor. */
export async function GET() {
  /* Public viewer: the launchpad section is captured on the VM inside the
     published snapshot; the viewer never touches RPC or wallet code. */
  if (isViewerMode()) {
    const snapshot = await readSnapshot();
    const launchpad = snapshot?.launchpad ?? null;
    if (!launchpad)
      return NextResponse.json({ error: "No snapshot published yet" }, { status: 503 });
    return NextResponse.json(launchpad, { headers: { "cache-control": "no-store" } });
  }

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
