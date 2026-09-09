import { startTelegram } from "@/lib/chat/telegram";
import { startDiscord } from "@/lib/chat/discord";
import { botsStatus } from "@/lib/chat/status";

declare global {
  var __lauraBotsStarted: boolean | undefined;
}

/** Starts whichever chat connectors have tokens configured. Idempotent. */
export function startBots(): void {
  if (globalThis.__lauraBotsStarted) return;
  globalThis.__lauraBotsStarted = true;
  botsStatus(); // initialise off/connecting labels
  const tg = process.env.TELEGRAM_BOT_TOKEN;
  const dc = process.env.DISCORD_BOT_TOKEN;
  if (tg) startTelegram(tg);
  if (dc) startDiscord(dc);
  if (!tg && !dc) {
    console.log("[laura] chat bots idle: set TELEGRAM_BOT_TOKEN and/or DISCORD_BOT_TOKEN to bring LAURA to your community");
  }
}
