export interface BotsStatus {
  telegram: string;
  discord: string;
}

declare global {
  var __lauraBots: BotsStatus | undefined;
}

export function botsStatus(): BotsStatus {
  globalThis.__lauraBots ??= {
    telegram: process.env.TELEGRAM_BOT_TOKEN ? "connecting" : "off (no TELEGRAM_BOT_TOKEN)",
    discord: process.env.DISCORD_BOT_TOKEN ? "connecting" : "off (no DISCORD_BOT_TOKEN)",
  };
  return globalThis.__lauraBots;
}

export function setBotStatus(bot: keyof BotsStatus, status: string): void {
  botsStatus()[bot] = status;
}
