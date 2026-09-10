/**
 * Rolling buffer of community chat LAURA's bots can see - the "cafe bar
 * chat" context source for token ideation.
 *
 * The Telegram and Discord handlers only ANSWER messages addressed to LAURA
 * (DMs, commands, @mentions); everything else in a group used to be dropped
 * on the floor. This module records that ambient group chatter (never DMs)
 * so the swarm's ideation prompts can hear what the community is actually
 * talking about between commands.
 *
 * Related: "The Cafe Bar" proper is the swarm's own agent forum
 * (src/lib/swarm/forum.ts) - the orchestrator folds forumDigest() into the
 * world context directly, so this buffer only needs to cover the EXTERNAL
 * community rooms. Optional: set CAFE_CHAT_KEYS on the VM to a comma list of
 * channel keys (e.g. "tg:-1001234567890,dc:987654321") to restrict the
 * digest to specific rooms; keys are visible in bot logs.
 *
 * No secrets here: the buffer is in-memory on the runtime VM only and never
 * serialized into dashboard state.
 */

export interface ChatterMsg {
  ts: number;
  /** Channel key, matching the chat handlers: "tg:<chatId>" / "dc:<channelId>" */
  channel: string;
  user: string;
  text: string;
}

const MAX_MESSAGES = 300;
const MAX_TEXT = 240;

declare global {
  // eslint-disable-next-line no-var
  var __lauraChatter: ChatterMsg[] | undefined;
}

function buffer(): ChatterMsg[] {
  if (!globalThis.__lauraChatter) globalThis.__lauraChatter = [];
  return globalThis.__lauraChatter;
}

/** Record one group message (callers must never pass DM content). */
export function recordChatter(msg: ChatterMsg): void {
  const text = msg.text.trim().slice(0, MAX_TEXT);
  if (!text) return;
  const buf = buffer();
  buf.push({ ...msg, text });
  if (buf.length > MAX_MESSAGES) buf.splice(0, buf.length - MAX_MESSAGES);
}

function ago(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Compact recent-chatter block for prompt injection, newest last. Optional
 * CAFE_CHAT_KEYS env narrows it to specific rooms (see module comment).
 * Empty string when there is nothing to show, so callers can filter it out.
 */
export function chatterDigest(limit = 12, maxAgeMs = 24 * 3600_000): string {
  const keysRaw = process.env.CAFE_CHAT_KEYS;
  const keys = keysRaw
    ? new Set(
        keysRaw
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      )
    : null;
  const cutoff = Date.now() - maxAgeMs;
  const rows = buffer()
    .filter((m) => m.ts >= cutoff && (!keys || keys.has(m.channel)))
    .slice(-limit);
  if (rows.length === 0) return "";
  const lines = rows.map((m) => `- [${ago(m.ts)}] ${m.user}: ${m.text}`);
  return `COMMUNITY CHAT (recent group messages LAURA's bots overheard)\n${lines.join("\n")}`;
}
