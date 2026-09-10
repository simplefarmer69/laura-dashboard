import { NextResponse, type NextRequest } from "next/server";
import { generateLauraLogo, generateLauraLogoPng, lauraLogoSvg } from "@/lib/launchpad/laura-logo";

/**
 * Serves LAURA's sentinel mark. Deterministic output, so it caches hard.
 *  - /api/laura/logo               crisp SVG (console header, chat avatar)
 *  - /api/laura/logo?format=png&size=512   raster for previews/exports
 *  - /api/laura/logo?format=webp   the exact 256px launcher-upload artifact
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const format = params.get("format") ?? "svg";
  const headers = { "Cache-Control": "public, max-age=86400, immutable" };
  try {
    if (format === "webp") {
      const bytes = await generateLauraLogo();
      return new NextResponse(new Uint8Array(bytes), {
        headers: { ...headers, "Content-Type": "image/webp" },
      });
    }
    if (format === "png") {
      const size = Math.min(1024, Math.max(16, Number(params.get("size")) || 512));
      const bytes = await generateLauraLogoPng(size);
      return new NextResponse(new Uint8Array(bytes), {
        headers: { ...headers, "Content-Type": "image/png" },
      });
    }
    return new NextResponse(lauraLogoSvg(), {
      headers: { ...headers, "Content-Type": "image/svg+xml" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
