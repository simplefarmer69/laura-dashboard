import { NextResponse } from "next/server";
import { authorized, opsEnabled, requestFlag, UPDATE_FLAG } from "@/lib/ops";

export const dynamic = "force-dynamic";

/** Ask the daemon's updater to fetch, build and switch to github/main at its next pass. */
export async function POST(req: Request) {
  if (!opsEnabled()) return new NextResponse(null, { status: 404 });
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await requestFlag(UPDATE_FLAG, "update requested via /api/ops/update");
  return NextResponse.json({ ok: true, note: "updater will pick this up within a minute; watch /api/ops/status daemonLog" });
}
