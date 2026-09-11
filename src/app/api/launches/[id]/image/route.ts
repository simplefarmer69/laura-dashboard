import { NextResponse, type NextRequest } from "next/server";
import { isViewerMode } from "@/lib/viewer/mode";
import { readSnapshot } from "@/lib/viewer/store";
import { loadState } from "@/lib/store";
import { ensureLaunchArt, generateTokenArt } from "@/lib/launchpad/art";
import type { LaunchProposal } from "@/lib/types";

export const dynamic = "force-dynamic";

async function findLaunch(id: string): Promise<LaunchProposal | null> {
  /* Public viewer: read the launch from the published snapshot; the art is
     deterministic from the spec, so it regenerates in memory (no data dir). */
  if (isViewerMode()) {
    const snapshot = await readSnapshot();
    const launches = (snapshot?.launches ?? []) as LaunchProposal[];
    return launches.find((l) => l.id === id) ?? null;
  }
  const state = await loadState();
  return state.launches.find((l) => l.id === id) ?? null;
}

/** Serves a launch's procedurally generated token logo (256px WebP). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/launches/[id]/image">) {
  const { id } = await ctx.params;
  const launch = await findLaunch(id);
  if (!launch) return NextResponse.json({ error: "Launch not found" }, { status: 404 });
  try {
    const spec = {
      name: launch.name,
      symbol: launch.symbol,
      motif: launch.artMotif,
      palette: launch.artPalette,
      style: launch.artStyle,
    };
    const bytes = isViewerMode()
      ? await generateTokenArt(spec)
      : await ensureLaunchArt(launch.id, spec);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
