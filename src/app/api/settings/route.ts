import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { updateState } from "@/lib/store";

export const dynamic = "force-dynamic";

const settingsSchema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    chainSlug: z.string().min(2).max(40),
    chainId: z.number().int().positive(),
    llamaSlug: z.string().min(2).max(60),
    projectName: z.string().min(1).max(60),
    projectSite: z.string().url(),
    cycleIntervalHours: z.number().min(1).max(24),
    autoApplyStrategyProposals: z.boolean(),
    maxDraftsPerCycle: z.number().int().min(1).max(20),
    llmModel: z.string().max(80),
    autoTune: z.boolean(),
    autoApproveProposals: z.boolean(),
  })
  .partial();

export async function PATCH(req: NextRequest) {
  const parsed = settingsSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const settings = await updateState((state) => {
    state.settings = { ...state.settings, ...parsed.data };
    return state.settings;
  });
  return NextResponse.json(settings);
}
