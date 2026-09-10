import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isViewerMode, viewerForbidden } from "@/lib/viewer/mode";
import { pushEvent, updateState } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Operator review for builder utility projects. Approve/reject only: there is
 * deliberately no "execute" action here. Execution is tick-driven on the VM
 * (runBuilderTick) and additionally gated by settings.autoExecuteUtility plus
 * the hard BUILDER_CAPS, so this route can never trigger a spend by itself.
 */
const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  reviewerNote: z.string().max(500).optional(),
});

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/utility/[id]">) {
  if (isViewerMode()) return viewerForbidden();
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const { action, reviewerNote } = parsed.data;

  const result = await updateState((state) => {
    const project = (state.utilityProjects ?? []).find((p) => p.id === id);
    if (!project) return { notFound: true as const };
    if (project.status !== "pending" && project.status !== "approved") {
      return { conflict: `Cannot ${action} a ${project.status} utility project` };
    }
    project.status = action === "approve" ? "approved" : "rejected";
    project.reviewedAt = Date.now();
    project.reviewerNote = reviewerNote ?? null;
    const agent = state.agents.find((a) => a.id === "builder");
    if (agent) {
      if (action === "approve") agent.stats.approved += 1;
      else agent.stats.rejected += 1;
    }
    pushEvent(state, {
      kind: action === "approve" ? "utility.approved" : "utility.rejected",
      agentId: "operator",
      title: `${action === "approve" ? "Approved" : "Rejected"} utility build for $${project.tokenSymbol}: ${project.title}`,
      detail: reviewerNote ?? project.utility,
      refId: project.id,
    });
    return { project };
  });

  if ("notFound" in result) return NextResponse.json({ error: "Utility project not found" }, { status: 404 });
  if ("conflict" in result) return NextResponse.json({ error: result.conflict }, { status: 409 });
  return NextResponse.json(result.project);
}
