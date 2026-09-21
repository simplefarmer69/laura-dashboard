import {
  pagerModConfigured,
  pagerModDeleteMessage,
  pagerModMute,
  pagerModPost,
  pagerModReadRoom,
  pagerModThreads,
  pagerNotifications,
  pagerPostAsHolder,
} from "@/lib/pager/client";
import { pushEvent } from "@/lib/store";
import { isViewerMode } from "@/lib/viewer/mode";
import type { SwarmState } from "@/lib/types";

/**
 * LAURA on Pager, the holders-only messenger (operator grant 2026-09-20).
 * She wears two hats and this rail keeps them apart, exactly as
 * `library/91-pager.md` requires.
 *
 *  - HOLDER: answers what is directed at her (replies, mentions, DMs, job
 *    rooms), posting as LAURA with the Intern 1990 face.
 *  - MODERATOR: sweeps the public rooms and removes fud aimed at holders,
 *    slurs, spam, scam links and drainer bait.
 *
 * Judgement belongs to the model; this module owns the parts that must never
 * depend on one. Deletion is the only destructive action available and it is
 * bounded here: a hard per-pass ceiling, an allowlist of public rooms, and a
 * refusal to touch anything private. A muted wallet can still read.
 *
 * Fails closed. No moderator key, viewer mode, or no live model means the
 * sweep reads and reports without deleting, because an unreviewed delete is
 * worse than a slow one.
 */

/** Never delete more than this in one pass, whatever the model proposes. */
export const PAGER_CAPS = {
  maxDeletesPerPass: 5,
  maxRepliesPerPass: 3,
  /** Second strike mutes; see library/91-pager.md. */
  deletionsBeforeMute: 2,
  /** Private rooms are out of scope for moderation, by prefix. */
  privateRoomPrefixes: ["dm:", "notedm:", "job:"] as const,
} as const;

export function isPrivateRoom(room: string): boolean {
  return PAGER_CAPS.privateRoomPrefixes.some((p) => room.startsWith(p));
}

export interface PagerSweep {
  rooms: string[];
  messages: { room: string; id: string; wallet: string; username?: string; text: string; ts: number }[];
  notifications: unknown[];
  since: number;
  newestTs: number;
}

/**
 * Everything the moderator hat should look at since `since`: the general room
 * plus every thread touched since then. Read only; deletes nothing.
 */
export async function pagerSweep(since: number): Promise<PagerSweep> {
  const rooms = ["general"];
  const threads = (await pagerModThreads().catch(() => ({ threads: [] }))) as {
    threads?: { id: string; lastAt?: number }[];
  };
  for (const t of threads.threads ?? []) {
    if ((t.lastAt ?? 0) > since) rooms.push(`thread:${t.id}`);
  }

  const messages: PagerSweep["messages"] = [];
  let newestTs = since;
  for (const room of rooms) {
    if (isPrivateRoom(room)) continue;
    const res = (await pagerModReadRoom(room, since).catch(() => ({ messages: [] }))) as {
      messages?: { id: string; wallet: string; username?: string; text: string; ts: number }[];
    };
    for (const m of res.messages ?? []) {
      messages.push({ room, ...m });
      if (m.ts > newestTs) newestTs = m.ts;
    }
  }

  const notifications = await pagerNotifications(since).catch(() => []);
  return { rooms, messages, notifications: notifications as unknown[], since, newestTs };
}

/**
 * The floor, rendered for agent context: what other holders are saying, and
 * separately what is aimed at LAURA and deserves an answer.
 *
 * Message ids are printed because a reply must quote the message it answers
 * (`replyToId`), otherwise the other holder is never notified it happened.
 * Private rooms never appear here: what is said in a DM is not context for
 * anything, least of all a post.
 */
export function pagerDigest(sweep: PagerSweep, limit = 24): string {
  const lines: string[] = [];
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  lines.push(`NOW: ${now}Z. You are LAURA on Pager, the holders-only messenger on stonkbrokers.io.`);
  lines.push(`You are here as a holder (Intern 1990 is your face) and as the moderator. Never mix the two.`);

  const directed = sweep.notifications as {
    kind?: string;
    room?: string;
    messageId?: string;
    preview?: string;
    from?: string;
    ts?: number;
  }[];
  if (directed.length) {
    lines.push(`\nDIRECTED AT YOU (${directed.length}; answer what deserves an answer, quote with replyToId):`);
    for (const n of directed.slice(0, 12)) {
      const who = (n.from ?? "").slice(0, 10);
      lines.push(`  [${n.kind ?? "note"}] room=${n.room ?? "?"} replyToId=${n.messageId ?? "?"} from=${who} :: ${String(n.preview ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    }
  } else {
    lines.push(`\nDIRECTED AT YOU: nothing new. Do not manufacture a reason to post.`);
  }

  const recent = [...sweep.messages].sort((a, b) => a.ts - b.ts).slice(-limit);
  if (recent.length) {
    lines.push(`\nTHE FLOOR (${sweep.messages.length} message(s) since last pass across ${sweep.rooms.length} room(s), oldest first):`);
    for (const m of recent) {
      /* Empty string, not absent, is what the server sends for a holder who
         has not claimed a username: fall through to the wallet so nobody
         appears in her context as a nameless voice. */
      const who = m.username?.trim() || m.wallet.slice(0, 10);
      lines.push(`  ${m.room} id=${m.id} ${who}: ${m.text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } else {
    lines.push(`\nTHE FLOOR: quiet since the last pass.`);
  }

  lines.push(
    `\nHOW TO BEHAVE HERE. Answer as a holder among holders, with facts you can source from the library or a live read; never a number you cannot point at. Criticism of the protocol is not fud and is never moderated. Visible copy takes no hyphens or dashes, no gambling words, and "AI" not "A.I".`,
  );
  return lines.join("\n");
}

export interface PagerModAction {
  room: string;
  messageId: string;
  wallet: string;
  /** Why it goes, in the words the moderator would use if asked. */
  reason: string;
  /** Optional one-line note posted as the moderator when a delete could look arbitrary. */
  note?: string;
}

/**
 * Applies moderator decisions. Refuses private rooms and anything past the
 * per-pass ceiling, and mutes a wallet on its second removal. Returns what it
 * actually did, which is what gets written to the event log.
 */
export async function pagerApplyModeration(
  actions: PagerModAction[],
  priorDeletionsByWallet: Map<string, number>,
): Promise<{ deleted: PagerModAction[]; muted: string[]; refused: string[] }> {
  const deleted: PagerModAction[] = [];
  const muted: string[] = [];
  const refused: string[] = [];
  if (!pagerModConfigured()) return { deleted, muted, refused: ["PAGER_MOD_KEY not set"] };

  for (const a of actions) {
    if (deleted.length >= PAGER_CAPS.maxDeletesPerPass) {
      refused.push(`${a.messageId}: per-pass delete ceiling (${PAGER_CAPS.maxDeletesPerPass})`);
      continue;
    }
    if (isPrivateRoom(a.room)) {
      refused.push(`${a.messageId}: ${a.room} is private and moderation does not reach it`);
      continue;
    }
    if (!a.reason?.trim()) {
      refused.push(`${a.messageId}: no reason given`);
      continue;
    }
    try {
      await pagerModDeleteMessage(a.room, a.messageId);
      deleted.push(a);
      const n = (priorDeletionsByWallet.get(a.wallet.toLowerCase()) ?? 0) + 1;
      priorDeletionsByWallet.set(a.wallet.toLowerCase(), n);
      if (n >= PAGER_CAPS.deletionsBeforeMute && !muted.includes(a.wallet)) {
        await pagerModMute(a.wallet, true);
        muted.push(a.wallet);
      }
      if (a.note?.trim()) await pagerModPost(a.room, a.note.trim());
    } catch (err) {
      refused.push(`${a.messageId}: ${String(err).slice(0, 120)}`);
    }
  }
  return { deleted, muted, refused };
}

export interface PagerReply {
  room: string;
  text: string;
  replyToId?: string;
}

/** Posts the holder-hat replies, bounded per pass. Quote the message so the other holder is notified. */
export async function pagerSendReplies(replies: PagerReply[]): Promise<{ sent: number; failed: string[] }> {
  const failed: string[] = [];
  let sent = 0;
  for (const r of replies.slice(0, PAGER_CAPS.maxRepliesPerPass)) {
    const bad = visibleCopyProblem(r.text);
    if (bad) {
      failed.push(`${r.room}: ${bad}`);
      continue;
    }
    try {
      await pagerPostAsHolder(r.room, r.text, r.replyToId);
      sent += 1;
    } catch (err) {
      failed.push(`${r.room}: ${String(err).slice(0, 120)}`);
    }
  }
  return { sent, failed };
}

/**
 * The site's visible-copy rules, checked in code so a slip cannot reach the
 * floor: no hyphens or dashes, no gambling vocabulary, "AI" not "A.I".
 */
export function visibleCopyProblem(text: string): string | null {
  if (/[-\u2013\u2014]/.test(text)) return "visible copy must not contain hyphens or dashes";
  if (/\bA\.I\b/i.test(text)) return 'write "AI", not "A.I"';
  if (/\b(bet|betting|gamble|gambling|casino|jackpot|odds)\b/i.test(text)) return "gambling vocabulary is not allowed in visible copy";
  if (!text.trim()) return "empty";
  return null;
}

/**
 * Records a pass on the swarm's event log. Writes into the state the cycle
 * already holds rather than loading and saving its own copy: an independent
 * save from inside a cycle is overwritten by the orchestrator's, which is how
 * the job records were lost once already.
 */
export function recordPagerPass(
  state: SwarmState,
  summary: { read: number; rooms: number; deleted: number; muted: string[]; replied: number; notifications: number },
): void {
  if (isViewerMode()) return;
  pushEvent(state, {
    kind: "pager.pass",
    agentId: "desk",
    refId: null,
    title: `Pager: read ${summary.read} message(s) across ${summary.rooms} room(s)`,
    detail: `${summary.replied} reply(ies) as holder · ${summary.deleted} deletion(s) as moderator${
      summary.muted.length ? ` · muted ${summary.muted.join(", ")}` : ""
    } · ${summary.notifications} notification(s)`,
  });
}
