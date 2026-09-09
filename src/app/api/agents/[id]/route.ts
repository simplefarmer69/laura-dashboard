import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { updateState } from "@/lib/store";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  status: z.enum(["idle", "paused"]).optional(),
  strategy: z.string().min(40).max(4000).optional(),
});

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/agents/[id]">) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const agent = await updateState((state) => {
    const a = state.agents.find((x) => x.id === id);
    if (!a) return null;
    if (parsed.data.status) a.status = parsed.data.status;
    if (parsed.data.strategy && parsed.data.strategy !== a.strategy) {
      a.history.push({
        version: a.strategyVersion,
        strategy: a.strategy,
        adoptedAt: Date.now(),
        reason: "Superseded: manual edit by operator",
      });
      a.strategy = parsed.data.strategy;
      a.strategyVersion += 1;
    }
    return a;
  });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(agent);
}
