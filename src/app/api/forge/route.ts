import { NextResponse } from "next/server";
import { isViewerMode } from "@/lib/viewer/mode";
import { readSnapshot } from "@/lib/viewer/store";
import { loadState } from "@/lib/store";
import { FORGE_CAPS, forgeCapacityDigest } from "@/lib/forge/caps";
import type { ForgeProject } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Public feed of LAURA's own contracts (Anvil designs and flagship deployments). */
function publicProject(p: ForgeProject) {
  const { bytecode, ...rest } = p;
  void bytecode;
  return rest;
}

export async function GET() {
  if (isViewerMode()) {
    const snap = await readSnapshot();
    const projects = ((snap?.forgeProjects as ForgeProject[] | undefined) ?? []).map(publicProject);
    return NextResponse.json({ ok: true, caps: FORGE_CAPS, projects });
  }
  const state = await loadState();
  return NextResponse.json({
    ok: true,
    caps: FORGE_CAPS,
    capacity: forgeCapacityDigest(state),
    projects: (state.forgeProjects ?? []).map(publicProject),
  });
}
