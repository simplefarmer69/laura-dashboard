import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import { askLaura } from "@/lib/chat/laura";
import { setBotStatus } from "@/lib/chat/status";
import { recordChatter } from "@/lib/chat/chatter";

/**
 * Discord connector. Set DISCORD_BOT_TOKEN (Discord Developer Portal) and
 * enable the MESSAGE CONTENT intent on the bot. LAURA replies to DMs and to
 * messages that @mention her in servers; she never posts unprompted.
 */
export function startDiscord(token: string): void {
  setBotStatus("discord", "connecting");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on("clientReady", () => {
    setBotStatus("discord", `online as ${client.user?.tag ?? "?"}`);
    console.log(`[laura] discord online as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (msg) => {
    try {
      if (msg.author.bot || !client.user) return;
      const isDm = msg.channel.type === ChannelType.DM;
      /* Server chatter (never DMs) feeds the swarm's community context. */
      if (!isDm && msg.content?.trim()) {
        recordChatter({
          ts: Date.now(),
          channel: `dc:${msg.channelId}`,
          user: msg.author.username ?? "anon",
          text: msg.content,
        });
      }
      const mentioned = msg.mentions.users.has(client.user.id);
      if (!isDm && !mentioned) return;

      const clean = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
      const { reply, rateLimited } = await askLaura({
        channelKey: `dc:${msg.channelId}`,
        userId: `dc:${msg.author.id}`,
        username: msg.author.username,
        text: clean || "help",
      });
      if (rateLimited || !reply) return;
      await msg.reply({ content: reply, allowedMentions: { repliedUser: true } });
    } catch (err) {
      console.error("[laura] discord message error:", err);
    }
  });

  client.on("error", (err) => {
    console.error("[laura] discord error:", err);
    setBotStatus("discord", `error: ${String(err).slice(0, 120)}`);
  });

  client.login(token).catch((err) => {
    console.error("[laura] discord login failed:", err);
    setBotStatus("discord", `error: ${String(err).slice(0, 120)}`);
  });
}
