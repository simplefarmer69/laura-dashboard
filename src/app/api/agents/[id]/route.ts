import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isViewerMode, viewerForbidden } from "@/lib/viewer/mode";
import { pushEvent, updateState } from "@/lib/store";
import { adoptStrategy } from "@/lib/swarm/strategy";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  status: z.enum(["idle", "paused"]).optional(),
  strategy: z.string().min(40).max(4000).optional(),
});

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/agents/[id]">) {
  if (isViewerMode()) return viewerForbidden();
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const agent = await updateState((state) => {
    const a = state.agents.find((x) => x.id === id);
    if (!a) return null;
    if (parsed.data.status && parsed.data.status !== a.status) {
      a.status = parsed.data.status;
      pushEvent(state, {
        kind: parsed.data.status === "paused" ? "agent.paused" : "agent.resumed",
        agentId: "operator",
        title: `${a.name} ${parsed.data.status === "paused" ? "paused" : "resumed"}`,
        detail: "Operator action from the console",
        refId: a.id,
      });
    }
    if (parsed.data.strategy && parsed.data.strategy !== a.strategy) {
      adoptStrategy(state, a, parsed.data.strategy, "Manual edit by operator", "operator");
    }
    return a;
  });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(agent);
}
