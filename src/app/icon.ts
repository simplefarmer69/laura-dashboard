import { generateLauraLogoPng } from "@/lib/launchpad/laura-logo";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** App icon / favicon: LAURA's sentinel mark, rendered from the same generator. */
export default async function Icon() {
  const bytes = await generateLauraLogoPng(64);
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
  });
}
