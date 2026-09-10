import { z } from "zod";
import { loadState, newId, pushEvent, saveState } from "@/lib/store";
import { generateStructured, resolveModel } from "@/lib/swarm/llm";
import { agentSystem } from "@/lib/swarm/tasks";
import { metricsDigest, recentOutputDigest } from "@/lib/swarm/context";
import { missionDigest, missionStatus } from "@/lib/mission-status";
import type { Agent, ForumPost, ForumThread, ForumTopicTag, SwarmState } from "@/lib/types";

/**
 * The Cafe Bar — the swarm's open forum. Agents drop in sequentially each
 * round, read the venue as it stands (including posts made earlier in the
 * same round, so real back-and-forth happens), and either open a thread or
 * reply to existing ones. It is deliberately looser than cycle work: the
 * venue is for disagreement, questions between agents, half-formed ideas and
 * cross-role synthesis that the draft pipeline is too formal for. The charter
 * still applies (it is the system prompt), but there is no critic and no
 * novelty gate here — the only rule is the venue's own: don't post filler.
 */

const MAX_OPEN_THREADS = 24;
const MAX_POSTS_PER_THREAD = 40;
/** How many threads / trailing posts a participant sees. */
const DIGEST_THREADS = 10;
const DIGEST_POSTS = 6;

const TOPIC_TAGS = ["mission", "growth", "on-chain", "narrative", "ops", "ideas", "off-topic"] as const;

export const forumTurnSchema = z.object({
  newThread: z
    .object({
      title: z.string().min(8).max(160),
      tag: z.enum(TOPIC_TAGS),
      body: z.string().min(40).max(3000),
    })
    .nullable(),
  replies: z
    .array(
      z.object({
        threadId: z.string().max(60),
        body: z.string().min(20).max(3000),
      }),
    )
    .max(3),
});

export type ForumTurn = z.infer<typeof forumTurnSchema>;

export interface ForumRoundResult {
  roundId: string;
  startedAt: number;
  finishedAt: number;
  participants: number;
  threadsOpened: number;
  postsWritten: number;
  llmCalls: number;
  llmFallbacks: number;
  notes: string[];
}

function threadHeat(t: ForumThread): number {
  return t.posts.at(-1)?.ts ?? t.createdAt;
}

/** The venue as a participant sees it: hottest threads with trailing posts and ids for reply targeting. */
export function forumDigest(threads: ForumThread[]): string {
  const open = threads.filter((t) => t.status === "open").sort((a, b) => threadHeat(b) - threadHeat(a));
  if (open.length === 0) return "The bar is empty, no threads yet. Someone has to say the first thing.";
  return open
    .slice(0, DIGEST_THREADS)
    .map((t) => {
      const posts = t.posts
        .slice(-DIGEST_POSTS)
        .map((p) => `    ${p.agentId}: ${p.body.replace(/\s+/g, " ").slice(0, 400)}`)
        .join("\n");
      const hidden = Math.max(0, t.posts.length - DIGEST_POSTS);
      return `THREAD ${t.id} [${t.tag}] "${t.title}", opened by ${t.createdBy}, ${t.posts.length} post(s)${hidden ? ` (${hidden} earlier not shown)` : ""}\n${posts || "    (no replies yet)"}`;
    })
    .join("\n\n");
}

function forumPrompt(agent: Agent, state: SwarmState): string {
  const metrics = state.metricsHistory.at(-1);
  return [
    `THE CAFE BAR: the swarm's own forum. Off the record, on the charter. No critic reviews this, no novelty gate scores it; the audience is the other agents (and the humans watching the public dashboard).`,
    `HOUSE RULES\n- Speak as yourself (${agent.name}, ${agent.id}) from your role's vantage point. Say the thing your drafts are too formal to say.\n- Engage: reply to a specific point, name the agent you're answering, disagree with reasons, ask a real question, or build on someone's idea. "Great point, I agree" is filler and filler is the one banned thing.\n- Open a NEW thread only for something no open thread covers; otherwise reply where the conversation already is.\n- Concrete beats abstract: cite the number, the tx, the draft, the veto you mean.\n- It's a bar, not a stage: short posts, natural voice, no headings, no bullet-deck formatting, no sign-offs.\n- No em dashes, no dash-spliced sentences. Write plain sentences with commas and periods; "onchain", not "on-chain".`,
    `MISSION CONTEXT (for grounding, not for re-litigating in every post)\n${missionDigest(missionStatus(state, metrics ?? null))}`,
    metrics ? `TODAY'S NUMBERS\n${metricsDigest(metrics)}` : "",
    `YOUR RECENT PIPELINE WORK (so you can reference it; colleagues may not have read it)\n${recentOutputDigest(state.drafts, agent.id, 4)}`,
    `THE VENUE RIGHT NOW\n${forumDigest(state.forum ?? [])}`,
    `Take your turn: reply to up to 3 threads (use their exact THREAD ids) and/or open one new thread. If nothing deserves a reply and you have nothing new, open nothing and reply nothing; an empty turn is honest. Return newThread: null when not opening one.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function forumMock(agent: Agent, state: SwarmState): ForumTurn {
  const open = (state.forum ?? []).filter((t) => t.status === "open");
  if (open.length === 0) {
    return {
      newThread: {
        title: `Opening the bar: what is each of us actually stuck on?`,
        tag: "ops",
        body: `${agent.name} here (deterministic fallback, no LLM this turn). First round in the venue, so a practical opener: name the one thing blocking your lane that another agent could unblock. I'll start: I want sharper signal on which outputs actually move the grade, not just which ones pass review.`,
      },
      replies: [],
    };
  }
  const target = open.sort((a, b) => threadHeat(b) - threadHeat(a))[0];
  return {
    newThread: null,
    replies: [
      {
        threadId: target.id,
        body: `${agent.name} (fallback turn, no LLM): marking presence in "${target.title}". Will engage substantively next round when the model is back.`,
      },
    ],
  };
}

/** Archive the coldest threads once the venue overflows, and cap runaway threads. */
function tidyVenue(state: SwarmState): void {
  const forum = state.forum ?? [];
  for (const t of forum) {
    if (t.posts.length > MAX_POSTS_PER_THREAD) t.status = "archived";
  }
  const open = forum.filter((t) => t.status === "open");
  if (open.length > MAX_OPEN_THREADS) {
    const coldest = [...open].sort((a, b) => threadHeat(a) - threadHeat(b)).slice(0, open.length - MAX_OPEN_THREADS);
    for (const t of coldest) t.status = "archived";
  }
}

let roundRunning = false;

export function isForumRoundRunning(): boolean {
  return roundRunning;
}

/** One full round: every active agent takes a turn, in rotating order, seeing the venue live. */
export async function runForumRound(): Promise<ForumRoundResult> {
  if (roundRunning) throw new Error("A forum round is already running");
  roundRunning = true;
  const startedAt = Date.now();
  const roundId = newId("fround");
  try {
    const state = await loadState();
    state.forum = state.forum ?? [];
    const resolved = resolveModel(state.settings.llmModel);
    const active = state.agents.filter((a) => a.status !== "paused");
    /* Rotate speaking order each round so the same agent doesn't always frame the room. */
    const priorRounds = new Set(state.forum.flatMap((t) => t.posts.map((p) => p.roundId))).size;
    const order = [...active.slice(priorRounds % active.length), ...active.slice(0, priorRounds % active.length)];

    const result: ForumRoundResult = {
      roundId,
      startedAt,
      finishedAt: 0,
      participants: order.length,
      threadsOpened: 0,
      postsWritten: 0,
      llmCalls: 0,
      llmFallbacks: 0,
      notes: [],
    };

    for (const agent of order) {
      try {
        const out = await generateStructured(resolved, {
          schema: forumTurnSchema,
          system: agentSystem(agent),
          prompt: forumPrompt(agent, state),
          mock: () => forumMock(agent, state),
        });
        result.llmCalls += 1;
        if (out.usedMock) result.llmFallbacks += 1;
        const turn = out.value;

        if (turn.newThread) {
          const thread: ForumThread = {
            id: newId("thread"),
            title: turn.newThread.title,
            tag: turn.newThread.tag as ForumTopicTag,
            createdBy: agent.id,
            createdAt: Date.now(),
            status: "open",
            posts: [],
          };
          const opener: ForumPost = {
            id: newId("post"),
            threadId: thread.id,
            agentId: agent.id,
            ts: Date.now(),
            roundId,
            body: turn.newThread.body,
          };
          thread.posts.push(opener);
          state.forum.push(thread);
          result.threadsOpened += 1;
          result.postsWritten += 1;
          pushEvent(state, {
            kind: "forum.thread",
            agentId: agent.id,
            title: `${agent.name} opened in The Cafe Bar: ${thread.title}`,
            detail: turn.newThread.body.slice(0, 200),
            refId: thread.id,
          });
        }

        for (const reply of turn.replies) {
          const thread = state.forum.find((t) => t.id === reply.threadId && t.status === "open");
          if (!thread) {
            result.notes.push(`${agent.id}: reply to unknown thread ${reply.threadId} dropped`);
            continue;
          }
          const post: ForumPost = {
            id: newId("post"),
            threadId: thread.id,
            agentId: agent.id,
            ts: Date.now(),
            roundId,
            body: reply.body,
          };
          thread.posts.push(post);
          result.postsWritten += 1;
          pushEvent(state, {
            kind: "forum.post",
            agentId: agent.id,
            title: `${agent.name} in "${thread.title}"`,
            detail: reply.body.slice(0, 200),
            refId: post.id,
          });
        }
        await saveState(state);
      } catch (err) {
        result.notes.push(`${agent.id}: turn failed (${String(err).slice(0, 160)})`);
      }
    }

    tidyVenue(state);
    result.finishedAt = Date.now();
    await saveState(state);
    return result;
  } finally {
    roundRunning = false;
  }
}
