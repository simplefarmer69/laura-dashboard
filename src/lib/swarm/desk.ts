import { pagerHolderSession } from "@/lib/pager/client";
import { jobBoardDigest, pagerJobBoard } from "@/lib/pager/jobs";
import { pagerApplyModeration, pagerDigest, pagerSendReplies, pagerSweep, recordPagerPass } from "@/lib/pager/rail";
import { generateStructured, type ResolvedModel } from "@/lib/swarm/llm";
import { agentSystem, deskMock, deskPrompt, deskSchema, type CycleContext } from "@/lib/swarm/tasks";
import type { Agent, SwarmState } from "@/lib/types";

/**
 * Desk: LAURA present on the Pager floor (operator grant 2026-09-20).
 *
 * One structured call reads everything directed at her since the last pass
 * plus the public rooms, and returns two separate lists: replies as herself,
 * removals as the moderator. The code keeps the hats apart and owns every
 * consequence: replies pass the site's copy rules before they leave, removals
 * are bounded per pass and refused on private rooms, and the cursor only
 * advances after a live model actually looked. A fallback plan answers
 * nobody, because a canned reply to a named person is worse than a late one.
 */

function log(msg: string): void {
  console.log(`[desk ${new Date().toISOString()}] ${msg}`);
}

const LOOKBACK_MS = 48 * 3600_000;

export interface DeskResult {
  replied: number;
  deleted: number;
  muted: string[];
  directed: number;
  read: number;
  held: boolean;
  notes: string[];
}

export async function runDesk(state: SwarmState, agent: Agent, resolved: ResolvedModel, ctx: CycleContext): Promise<DeskResult> {
  const since = Math.max(state.pagerCursor ?? 0, Date.now() - LOOKBACK_MS);
  const sweep = await pagerSweep(since);
  const notes: string[] = [];

  if (!sweep.notifications.length && !sweep.messages.length) {
    return { replied: 0, deleted: 0, muted: [], directed: 0, read: 0, held: true, notes: ["quiet since last pass"] };
  }

  /* The Work board rides along so a question about a job or a payout can be
     answered from the board's own record (status, worker, amount) instead
     of from memory. Holders ask about their pay more than anything else. */
  const board = await pagerJobBoard().catch(() => []);
  const wallet = (await pagerHolderSession()).wallet;
  const floor = board.length
    ? `${pagerDigest(sweep, 40)}\n\n${jobBoardDigest(board, wallet)}\nA job marked Paid has released its escrow to the worker's wallet on chain; cite the job number and its status when someone asks about their pay, and point them at the board.`
    : pagerDigest(sweep, 40);

  const out = await generateStructured(resolved, {
    schema: deskSchema,
    system: agentSystem(agent),
    prompt: deskPrompt(ctx, floor),
    mock: deskMock,
  });

  if (out.usedMock) {
    /* Do not advance the cursor. Whoever addressed her is still waiting, and
       they should be answered by her rather than marked as handled. */
    return { replied: 0, deleted: 0, muted: [], directed: sweep.notifications.length, read: sweep.messages.length, held: true, notes: ["no live model"] };
  }

  /* One reply per message id per pass, whatever the model returned. */
  const seen = new Set<string>();
  const replies = out.value.replies.filter((r) => {
    if (seen.has(r.replyToId)) return false;
    seen.add(r.replyToId);
    return true;
  });
  const sent = await pagerSendReplies(replies.map((r) => ({ room: r.room, text: r.text, replyToId: r.replyToId })));
  notes.push(...sent.failed.map((f) => `reply refused: ${f}`));
  for (const r of replies.slice(0, sent.sent)) log(`replied in ${r.room} to ${r.replyToId}: ${r.text.slice(0, 80)}`);

  const priorDeletions = new Map<string, number>();
  for (const e of state.events.slice(-500)) {
    if (e.kind !== "pager.pass") continue;
    const m = /muted (0x[0-9a-fA-F]{40})/.exec(e.detail);
    if (m) priorDeletions.set(m[1].toLowerCase(), 2);
  }
  const mod = await pagerApplyModeration(
    out.value.moderation.map((m) => ({ room: m.room, messageId: m.messageId, wallet: m.wallet, reason: m.reason, note: m.note ?? undefined })),
    priorDeletions,
  );
  notes.push(...mod.refused.map((r) => `moderation refused: ${r}`));
  for (const d of mod.deleted) log(`removed ${d.messageId} in ${d.room}: ${d.reason.slice(0, 80)}`);

  /* A live model looked at everything up to newestTs. Only now is it handled. */
  state.pagerCursor = Math.max(state.pagerCursor ?? 0, sweep.newestTs);

  recordPagerPass(state, {
    read: sweep.messages.length,
    rooms: sweep.rooms.length,
    deleted: mod.deleted.length,
    muted: mod.muted,
    replied: sent.sent,
    notifications: sweep.notifications.length,
  });

  return {
    replied: sent.sent,
    deleted: mod.deleted.length,
    muted: mod.muted,
    directed: sweep.notifications.length,
    read: sweep.messages.length,
    held: sent.sent === 0 && mod.deleted.length === 0,
    notes,
  };
}
