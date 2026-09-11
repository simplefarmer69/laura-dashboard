import { NextResponse } from "next/server";
import { authorized, opsEnabled, requestFlag, RESTART_FLAG } from "@/lib/ops";

export const dynamic = "force-dynamic";

/**
 * Ask for a graceful process restart: the scheduler exits at the next tick
 * with no cycle or forum round in flight, and the process manager (PM2 /
 * Railway) brings the process back. Honoured only when LAURA_DAEMON=1.
 */
export async function POST(req: Request) {
  if (!opsEnabled()) return new NextResponse(null, { status: 404 });
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.LAURA_DAEMON !== "1") {
    return NextResponse.json({ ok: false, error: "not running under a process manager (LAURA_DAEMON != 1)" }, { status: 409 });
  }
  await requestFlag(RESTART_FLAG, "restart requested via /api/ops/restart");
  return NextResponse.json({ ok: true, note: "process exits at the next quiet tick; the process manager restarts it" });
}
