import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { updateState } from "@/lib/store";
import type { DraftStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  status: z.enum(["approved", "rejected", "published", "pending"]),
  reviewerNote: z.string().max(500).optional(),
  body: z.string().max(8000).optional(),
});

function bump(stats: { approved: number; rejected: number; published: number }, from: DraftStatus, to: DraftStatus) {
  if (from === "approved") stats.approved -= 1;
  if (from === "rejected") stats.rejected -= 1;
  if (from === "published") stats.published -= 1;
  if (to === "approved") stats.approved += 1;
  if (to === "rejected") stats.rejected += 1;
  if (to === "published") stats.published += 1;
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/drafts/[id]">) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const result = await updateState((state) => {
    const draft = state.drafts.find((d) => d.id === id);
    if (!draft) return null;
    const agent = state.agents.find((a) => a.id === draft.agentId);
    if (agent) bump(agent.stats, draft.status, parsed.data.status);
    draft.status = parsed.data.status;
    draft.reviewedAt = parsed.data.status === "pending" ? null : Date.now();
    if (parsed.data.reviewerNote !== undefined) draft.reviewerNote = parsed.data.reviewerNote;
    if (parsed.data.body !== undefined) draft.body = parsed.data.body;
    return draft;
  });
  if (!result) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  return NextResponse.json(result);
}
