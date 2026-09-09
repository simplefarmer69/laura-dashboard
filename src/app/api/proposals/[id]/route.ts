import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { updateState } from "@/lib/store";
import { applyProposal } from "@/lib/swarm/orchestrator";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  status: z.enum(["approved", "rejected"]),
  proposedStrategy: z.string().min(40).max(4000).optional(),
});

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/proposals/[id]">) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const result = await updateState((state) => {
    const proposal = state.proposals.find((p) => p.id === id);
    if (!proposal) return { error: "not_found" as const };
    if (proposal.status !== "pending") return { error: "already_reviewed" as const };
    if (parsed.data.proposedStrategy) proposal.proposedStrategy = parsed.data.proposedStrategy;
    if (parsed.data.status === "approved") {
      applyProposal(state, proposal, "Approved by operator");
    } else {
      proposal.status = "rejected";
      proposal.reviewedAt = Date.now();
    }
    return { proposal };
  });
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result.proposal);
}
