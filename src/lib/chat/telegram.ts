import { askLaura } from "@/lib/chat/laura";
import { setBotStatus } from "@/lib/chat/status";

/**
 * Telegram connector via long polling (getUpdates) — no public URL needed, so
 * it runs fine from this box. Set TELEGRAM_BOT_TOKEN (from @BotFather).
 * DMs always get a reply; in groups LAURA answers commands, @mentions and
 * replies to her own messages so she never spams the room.
 */

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
    reply_to_message?: { from?: { id: number } };
  };
}

function api(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function call<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(api(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(65_000),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
  return json.result;
}

export function startTelegram(token: string): void {
  setBotStatus("telegram", "connecting");
  const loop = async () => {
    const me = await call<{ id: number; username: string }>(token, "getMe");
    setBotStatus("telegram", `online as @${me.username}`);
    console.log(`[laura] telegram online as @${me.username}`);
    let offset = 0;
    for (;;) {
      try {
        const updates = await call<TgUpdate[]>(token, "getUpdates", {
          offset,
          timeout: 50,
          allowed_updates: ["message"],
        });
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          const msg = u.message;
          const text = msg?.text?.trim();
          if (!msg || !text || msg.from?.is_bot) continue;

          const isPrivate = msg.chat.type === "private";
          const mentioned = text.toLowerCase().includes(`@${me.username.toLowerCase()}`);
          const isCommand = text.startsWith("/");
          const isReplyToMe = msg.reply_to_message?.from?.id === me.id;
          if (!isPrivate && !mentioned && !isCommand && !isReplyToMe) continue;

          const clean = text
            .replace(new RegExp(`@${me.username}`, "gi"), "")
            .replace(/^\/(start|help)\b/, "help")
            .replace(/^\/(stats|price|mission)\b/, "$1")
            .trim();
          const { reply, rateLimited } = await askLaura({
            channelKey: `tg:${msg.chat.id}`,
            userId: `tg:${msg.from?.id ?? msg.chat.id}`,
            username: msg.from?.username ?? msg.from?.first_name,
            text: clean || "help",
          });
          if (rateLimited || !reply) continue;
          await call(token, "sendMessage", {
            chat_id: msg.chat.id,
            text: reply,
            reply_to_message_id: isPrivate ? undefined : msg.message_id,
          });
        }
      } catch (err) {
        console.error("[laura] telegram poll error:", err);
        setBotStatus("telegram", `error: ${String(err).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 10_000));
        setBotStatus("telegram", `online as @${me.username}`);
      }
    }
  };
  loop().catch((err) => {
    console.error("[laura] telegram failed to start:", err);
    setBotStatus("telegram", `error: ${String(err).slice(0, 120)}`);
  });
}
