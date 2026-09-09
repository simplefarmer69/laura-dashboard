import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { askLaura } from "@/lib/chat/laura";
import { botsStatus } from "@/lib/chat/status";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().min(1).max(1000),
  sessionId: z.string().min(1).max(64),
});

/** Operator chat with LAURA — the same brain the Discord/Telegram bots use. */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const out = await askLaura({
    channelKey: `console:${parsed.data.sessionId}`,
    userId: `console:${parsed.data.sessionId}`,
    username: "operator",
    text: parsed.data.message,
  });
  if (out.rateLimited)
    return NextResponse.json({ error: "One message every few seconds, please." }, { status: 429 });
  return NextResponse.json({ reply: out.reply, usedMock: out.usedMock });
}

export async function GET() {
  return NextResponse.json({ bots: botsStatus() });
}
