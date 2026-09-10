import { NextResponse, type NextRequest } from "next/server";
import { loadState } from "@/lib/store";
import { ensureLaunchArt } from "@/lib/launchpad/art";

export const dynamic = "force-dynamic";

/** Serves a launch's procedurally generated token logo (256px WebP). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/launches/[id]/image">) {
  const { id } = await ctx.params;
  const state = await loadState();
  const launch = state.launches.find((l) => l.id === id);
  if (!launch) return NextResponse.json({ error: "Launch not found" }, { status: 404 });
  try {
    const bytes = await ensureLaunchArt(launch.id, {
      name: launch.name,
      symbol: launch.symbol,
      motif: launch.artMotif,
      palette: launch.artPalette,
    });
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
