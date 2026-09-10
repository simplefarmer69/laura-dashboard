import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isViewerMode, viewerForbidden } from "@/lib/viewer/mode";
import { newId, pushEvent, updateState } from "@/lib/store";
import type { LaunchProposal } from "@/lib/types";
import { ensureLaunchArt } from "@/lib/launchpad/art";
import { ART_PALETTES, isDuplicateLaunch, launchSpecShape } from "@/lib/launchpad/spec";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  ...launchSpecShape,
  /* Manual creates may omit the lane; cycle specs (launchSpecShape) require it. */
  lane: launchSpecShape.lane.default("weth"),
  concept: z.string().min(10).max(1200),
  rationale: z.string().min(10).max(1200),
  /** The broadcast this launch makes to the Telegram audience — LAURA's words. */
  message: z.string().min(10).max(500).optional(),
  artMotif: z.string().min(2).max(80),
  artPalette: z.enum(ART_PALETTES),
  priority: z.number().min(0).max(100).optional(),
  approve: z.boolean().default(false),
});

/** Creates a launch spec directly (operator- or LAURA-designed outside a cycle). */
export async function POST(req: NextRequest) {
  if (isViewerMode()) return viewerForbidden();
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const p = parsed.data;

  const result = await updateState<{ ok: true; launch: LaunchProposal } | { ok: false; error: string }>((state) => {
    if (isDuplicateLaunch(state.launches, p.name, p.symbol))
      return { ok: false, error: `A non-rejected launch already uses ${p.name} or $${p.symbol}` };

    const launch: LaunchProposal = {
      id: newId("launch"),
      cycleId: "manual",
      createdAt: Date.now(),
      lane: p.lane,
      name: p.name,
      symbol: p.symbol,
      supplyTokens: p.supplyTokens,
      startMcapUsd: p.startMcapUsd,
      gradMcapUsd: p.gradMcapUsd,
      startTaxBps: p.startTaxBps,
      taxDecayPerMinuteBps: p.taxDecayPerMinuteBps,
      postTaxBps: p.postTaxBps,
      sellsEnabled: p.sellsEnabled,
      bufferSecs: p.bufferSecs,
      concept: p.concept,
      rationale: p.rationale,
      message: p.message ?? null,
      artMotif: p.artMotif,
      artPalette: p.artPalette,
      priority: p.priority ?? 0,
      status: p.approve ? "approved" : "pending",
      reviewedAt: p.approve ? Date.now() : null,
      reviewerNote: p.approve ? "Approved at creation" : null,
      txHash: null,
      tokenAddress: null,
      launchId: null,
      deployedAt: null,
      error: null,
      imageHash: null,
    };
    state.launches.push(launch);
    pushEvent(state, {
      kind: "launch.proposed",
      agentId: "operator",
      title: `Launch spec created: ${p.name} ($${p.symbol})`,
      detail: p.message ? `LAURA says: "${p.message}" · ${p.concept}` : p.concept,
      refId: launch.id,
    });
    if (p.approve) {
      pushEvent(state, {
        kind: "launch.approved",
        agentId: "operator",
        title: `Approved launch: ${p.name} ($${p.symbol})`,
        detail: "Approved at creation; deploys when the wallet is funded, within hard caps.",
        refId: launch.id,
      });
    }
    return { ok: true, launch };
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const launch = result.launch;
  try {
    await ensureLaunchArt(launch.id, {
      name: launch.name,
      symbol: launch.symbol,
      motif: launch.artMotif,
      palette: launch.artPalette,
    });
  } catch {
    /* art regenerates on demand */
  }
  return NextResponse.json(launch, { status: 201 });
}
