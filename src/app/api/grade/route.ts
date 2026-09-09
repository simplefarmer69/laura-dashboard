import { NextResponse } from "next/server";
import { runGrader } from "@/lib/swarm/orchestrator";

export const dynamic = "force-dynamic";

export async function POST() {
  const grade = await runGrader();
  return NextResponse.json(grade);
}
