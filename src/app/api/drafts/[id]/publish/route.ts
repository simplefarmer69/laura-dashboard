import { NextResponse, type NextRequest } from "next/server";
import { isViewerMode, viewerForbidden } from "@/lib/viewer/mode";
import { loadState, pushEvent, saveState, updateState } from "@/lib/store";
import { dryRunToX, publishToX, xStatus } from "@/lib/publish/x";
import { checkXGuards } from "@/lib/publish/x-guard";

export const dynamic = "force-dynamic";

/**
 * Publishes an operator-approved X draft for real through the X API.
 * With `?dry=1` it returns the creds check, shared-account guard verdict and
 * the exact tweet split without posting or mutating anything — the smoke-test
 * path for the shared @AiAgentkAia account.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/drafts/[id]/publish">) {
  if (isViewerMode()) return viewerForbidden();
  const { id } = await ctx.params;
  const state = await loadState();
  const draft = state.drafts.find((d) => d.id === id);
  if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  if (draft.status !== "approved")
    return NextResponse.json({ error: "Only approved drafts can be published" }, { status: 409 });
  if (!/^(x|twitter)$/i.test(draft.channel.trim()))
    return NextResponse.json(
      { error: `Automatic publishing supports channel "X" for now; this draft targets ${draft.channel}. Use Mark published after posting manually.` },
      { status: 409 },
    );

  if (req.nextUrl.searchParams.get("dry")) {
    const result = await dryRunToX(draft.body, draft.kind === "thread");
    return NextResponse.json({ dryRun: true, draftId: draft.id, ...result });
  }

  const status = xStatus();
  if (!status.ready)
    return NextResponse.json(
      { error: `X posting not configured. Missing: ${status.missing.join(", ")} (Access Token + Secret must have Read & Write).` },
      { status: 409 },
    );

  /* Shared-account guards (rate caps, duplicate memory, self-interaction) are
     checked here first so a refused click returns 429 without logging an error
     event; publishToX re-checks as defense in depth. */
  const guard = await checkXGuards(draft.body);
  if (!guard.ok)
    return NextResponse.json(
      { error: `X guard refused the post: ${guard.reasons.join("; ")}`, guard },
      { status: 429 },
    );

  try {
    const result = await publishToX(draft.body, draft.kind === "thread");
    const updated = await updateState((s) => {
      const d = s.drafts.find((x) => x.id === id);
      if (!d) return null;
      d.status = "published";
      d.reviewedAt = Date.now();
      d.publishedUrl = result.url;
      const agent = s.agents.find((a) => a.id === d.agentId);
      if (agent) {
        agent.stats.approved -= 1;
        agent.stats.published += 1;
      }
      pushEvent(s, {
        kind: "draft.published",
        agentId: "operator",
        title: `Published to X: ${d.title}`,
        detail: `${result.tweetIds.length} post(s) · ${result.url}`,
        refId: d.id,
      });
      return d;
    });
    return NextResponse.json({ draft: updated, url: result.url, tweets: result.tweetIds.length });
  } catch (err) {
    pushEvent(state, {
      kind: "error",
      agentId: "operator",
      title: `X publish failed: ${draft.title}`,
      detail: String(err),
      refId: draft.id,
    });
    await saveState(state);
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}