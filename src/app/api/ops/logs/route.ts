import { NextResponse } from "next/server";
import { authorized, opsEnabled, tailLog } from "@/lib/ops";

export const dynamic = "force-dynamic";

const LOG_FILES = ["pm2-out.log", "pm2-err.log", "daemon.log", "watchdog.log"] as const;

/** Tail of the daemon's log files (secrets scrubbed). ?lines=N (default 200, max 2000). */
export async function GET(req: Request) {
  if (!opsEnabled()) return new NextResponse(null, { status: 404 });
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const lines = Number(url.searchParams.get("lines") ?? 200);
  const only = url.searchParams.get("file");
  const files = only ? LOG_FILES.filter((f) => f === only) : [...LOG_FILES];
  const out: Record<string, string> = {};
  for (const f of files) out[f] = await tailLog(f, Number.isFinite(lines) ? lines : 200);
  return NextResponse.json(out);
}
