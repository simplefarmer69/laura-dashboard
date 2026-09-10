import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isViewerMode, viewerForbidden } from "@/lib/viewer/mode";
import { pushEvent, updateState } from "@/lib/store";
import { executeLaunch } from "@/lib/launchpad/executor";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["approve", "reject", "deploy"]),
  reviewerNote: z.string().max(500).optional(),
});

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/launches/[id]">) {
  if (isViewerMode()) return viewerForbidden();
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const { action, reviewerNote } = parsed.data;

  if (action !== "deploy") {
    const result = await updateState((state) => {
      const launch = state.launches.find((l) => l.id === id);
      if (!launch) return null;
      if (launch.status !== "pending" && launch.status !== "approved") return { error: `Cannot ${action} a ${launch.status} launch` };
      launch.status = action === "approve" ? "approved" : "rejected";
      launch.reviewedAt = Date.now();
      launch.reviewerNote = reviewerNote ?? null;
      const agent = state.agents.find((a) => a.id === "mint");
      if (agent) {
        if (action === "approve") agent.stats.approved += 1;
        else agent.stats.rejected += 1;
      }
      pushEvent(state, {
        kind: action === "approve" ? "launch.approved" : "launch.rejected",
        agentId: "operator",
        title: `${action === "approve" ? "Approved" : "Rejected"} launch: ${launch.name} ($${launch.symbol})`,
        detail: reviewerNote ?? launch.concept,
        refId: launch.id,
      });
      return launch;
    });
    if (!result) return NextResponse.json({ error: "Launch not found" }, { status: 404 });
    if ("error" in result) return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result);
  }

  /* Deploy: shared fail-closed path (wallet, caps, live bounds) + branding */
  const result = await executeLaunch(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.httpStatus });
  return NextResponse.json(result.launch);
}
