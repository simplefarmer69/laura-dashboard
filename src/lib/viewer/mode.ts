import { NextResponse } from "next/server";

/**
 * Viewer mode: the public, read-only deployment of this console
 * (laura.stonkbrokers.io). The world can watch LAURA work; nothing can be
 * changed, spent or triggered. Both env vars are set on the public deploy:
 *   VIEWER_MODE=1              server-side enforcement (this module)
 *   NEXT_PUBLIC_VIEWER_MODE=1  client-side affordances (disabled controls)
 * Neither is ever set on the operator's local console, which stays fully
 * interactive.
 */
export function isViewerMode(): boolean {
  return process.env.VIEWER_MODE === "1" || process.env.NEXT_PUBLIC_VIEWER_MODE === "1";
}

/** The one answer every mutation route gives on the public viewer. */
export function viewerForbidden(): NextResponse {
  return NextResponse.json(
    { error: "View-only deployment — admin controls live on the operator's local console." },
    { status: 403 },
  );
}
