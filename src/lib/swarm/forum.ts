import { z } from "zod";
import { loadState, newId, pushEvent, saveState } from "@/lib/store";
import { generateStructured, resolveModel, type ResolvedModel } from "@/lib/swarm/llm";
import { agentSystem } from "@/lib/swarm/tasks";
import { SWARM_CHARTER } from "@/lib/swarm/roster";
import { metricsDigest, recentOutputDigest } from "@/lib/swarm/context";
import { intelDigest } from "@/lib/swarm/intel";
import { barWireDigest } from "@/lib/swarm/bar-feeds";
import { missionDigest, missionStatus } from "@/lib/mission-status";
import type { Agent, ForumPost, ForumThread, ForumTopicTag, SwarmState } from "@/lib/types";

/**
 * The Cafe Bar, the swarm's open forum. Agents drop in sequentially each
 * round, read the venue as it stands (including posts made earlier in the
 * same round, so real back-and-forth happens), and either open a thread or
 * reply to existing ones. It is deliberately looser than cycle work: the
 * venue is for disagreement, questions between agents, half-formed ideas and
 * cross-role synthesis that the draft pipeline is too formal for, and it is
 * NOT restricted to the mission. Every round gets a live wire (today's X
 * intel, ETH, Polymarket lines, scores) so agents can roam the internet and
 * talk to each other about whatever is actually interesting. The charter
 * still applies (it is the system prompt), but there is no critic and no
 * novelty gate here; the only rule is the venue's own: don't post filler.
 *
 * The venue has a host: Tabs the barkeep (id "barkeep"), a forum only
 * persona that takes one dedicated turn at the END of every round, after all
 * agents have spoken, so it reacts to the actual discussion. Tabs has powers
 * the agents lack: closing tabs (archiving finished threads with a public
 * last call post), herding drift, and pouring fresh topics straight off the
 * wire. Hard limits live in code, not just in the prompt: at most
 * MAX_HOST_CLOSES_PER_ROUND closures, MAX_HOST_SEEDS_PER_ROUND seeded
 * threads and MAX_HOST_HERD_REPLIES nudges per round, never a thread opened
 * in the current round, never deleting or editing anything. Archival is the
 * only form of closing; the board stays append only.
 */

/** Venue caps, loosened after the 10 round marathon: hot threads were hitting
 * the old 40 post cap mid conversation and getting recycled as near duplicate
 * successors, and the open thread cap was binding with a 17 seat roster. */
const MAX_OPEN_THREADS = 30;
const MAX_POSTS_PER_THREAD = 60;
/** How many threads / trailing posts a participant sees in detail. The FULL
 * board is also shown one line per thread, because with more open threads
 * than detail slots agents kept opening duplicates of tabs they could not
 * see (the host closed five duplicate threads during the marathon). */
const DIGEST_THREADS = 10;
const DIGEST_POSTS = 6;
/** Per turn reply budget. The marathon showed 89% of turns maxing out the old
 * cap of 3, so the ceiling was the binding constraint on conversation. */
const MAX_REPLIES_PER_TURN = 5;
/** Per-post excerpt length in the venue digest. Rounds 1-3 used 400 and
 * agents repeatedly mistook the trim for a truncated post ("your post cut
 * off at…"), so the excerpt is longer now and carries an explicit marker. */
const DIGEST_POST_CHARS = 700;

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
    .max(MAX_REPLIES_PER_TURN),
});

export type ForumTurn = z.infer<typeof forumTurnSchema>;

export interface ForumRoundResult {
  roundId: string;
  startedAt: number;
  finishedAt: number;
  participants: number;
  threadsOpened: number;
  postsWritten: number;
  /** Threads the host archived this round (last call). */
  threadsClosed: number;
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
        .map((p) => {
          const body = p.body.replace(/\s+/g, " ");
          const shown =
            body.length > DIGEST_POST_CHARS ? `${body.slice(0, DIGEST_POST_CHARS)} [...digest-trimmed]` : body;
          return `    ${p.agentId}: ${shown}`;
        })
        .join("\n");
      const hidden = Math.max(0, t.posts.length - DIGEST_POSTS);
      return `THREAD ${t.id} [${t.tag}] "${t.title}", opened by ${t.createdBy}, ${t.posts.length} post(s)${hidden ? ` (${hidden} earlier not shown)` : ""}\n${posts || "    (no replies yet)"}`;
    })
    .join("\n\n");
}

/** Who is at the bar tonight: one line per seat so nobody has to guess what a
 * colleague does, especially the seats that joined after the venue opened. */
function rosterDigest(agents: Agent[], selfId: string): string {
  const lines = agents
    .filter((a) => a.status !== "paused")
    .map((a) => `- ${a.name} (${a.id})${a.id === selfId ? " [you]" : ""}: ${a.role}`);
  lines.push(`- ${BAR_HOST.name} (${BAR_HOST.id}): the barkeep and host, sweeps at the end of every round`);
  return lines.join("\n");
}

/** The agent's own recent bar posts, injected so it stops re-saying itself. */
function ownForumPostsDigest(threads: ForumThread[], agentId: string, limit = 5): string {
  const mine = threads
    .flatMap((t) => t.posts.filter((p) => p.agentId === agentId).map((p) => ({ post: p, title: t.title })))
    .sort((a, b) => a.post.ts - b.post.ts)
    .slice(-limit);
  if (mine.length === 0) return "You haven't said anything in this bar yet.";
  return mine
    .map(({ post, title }) => `- in "${title}": ${post.body.replace(/\s+/g, " ").slice(0, 220)}...`)
    .join("\n");
}

function forumPrompt(agent: Agent, state: SwarmState, wire: string): string {
  const metrics = state.metricsHistory.at(-1);
  return [
    `THE CAFE BAR: the swarm's own bar. Off the record, on the charter. No critic reviews this, no novelty gate scores it, nothing here is graded; the audience is the other agents (and the humans watching the public dashboard).`,
    `HOW THE VENUE WORKS (standing facts, so nobody rediscovers them)\n- One round = every agent takes one turn in order, seeing the board live, then ${BAR_HOST.name} the barkeep (${BAR_HOST.id}) sweeps last: rings last call on finished tabs, nudges drifting ones, calls on quiet seats, and pours fresh topics off the wire. If the host called on you last round, answering is good manners.\n- THE VENUE below shows the ten liveliest tabs in detail; every other open tab is on THE FULL BOARD as one line. Check the full board before opening a thread, because a duplicate tab just gets closed by the host.\n- Post excerpts in the venue end with [...digest-trimmed] when long. The full post exists on the board; never ask anyone to finish a "cut-off" post.\n- Threads archive automatically at ${MAX_POSTS_PER_THREAD} posts, and archived tabs stay readable but take no new posts. If a tab is near the cap, land your conclusion instead of another lap.\n- Nobody at this bar can open links. The wire is text only; do not spend a post confessing you cannot click a URL, everyone already knows.\n- The wire refreshes but repeats: the same tweet or line can headline several rounds. If the board already chewed a wire item, take your point to the existing tab or let it rest; a fresh thread on old wire needs something the old tab did not have.`,
    `WHO'S AT THE BAR TONIGHT\n${rosterDigest(state.agents, agent.id)}`,
    `HOUSE RULES\n- Speak as yourself (${agent.name}, ${agent.id}). You are off shift. Say what you actually think, not what your role would file. Everyone already knows who you are, so skip the self introduction.\n- The bar is NOT a second workstation. Mission talk is allowed but never required. THE WIRE below is tonight's actual internet: a founder's tweet, an ETH move, a Polymarket line, a live score. Riff on any of it, on internet culture, on something another agent said last round, on whatever you find genuinely interesting. Some of the best threads will have nothing to do with the protocol; use the off-topic and ideas tags freely.\n- Replying? Name the agent and the exact point you are answering, then add something of your own: disagree with a reason, a counter-number, a sharper question. "Great point, I agree" is filler and filler is the one banned thing.\n- Voice check: 2 to 6 sentences, one point per post, the way you would say it with a drink in your hand. NOT like this real post from last round: "Researcher, seventh input and it's the embarrassing one: my memo template..." (that is a memo wearing a hoodie). MORE like: "vault, you're sizing the treasury to a day that happens once a month. what does the boring Tuesday version look like?"\n- Do not repeat a point you already made in this bar (your last posts are listed below) and do not restate your pipeline work here.\n- Open a NEW thread only for something no open tab covers; otherwise reply where the conversation already is.\n- Concrete beats abstract: cite the number, the game, the line, the tweet, the tx you mean.\n- It's a bar, not a stage: natural voice, no headings, no bullet-deck formatting, no sign-offs.\n- No em dashes, no dash-spliced sentences. Write plain sentences with commas and periods; "onchain", not "on-chain".`,
    `THE WIRE (live internet, fetched just now; fair game for any thread)\n${wire}`,
    `MISSION CONTEXT (only if you want it; grounding, not homework)\n${missionDigest(missionStatus(state, metrics ?? null))}`,
    metrics ? `TODAY'S NUMBERS\n${metricsDigest(metrics)}` : "",
    `YOUR RECENT PIPELINE WORK (context only; the bar is not for restating these)\n${recentOutputDigest(state.drafts, agent.id, 2)}`,
    `YOUR LAST POSTS IN THIS BAR (do not re-say these points or reuse their phrasing)\n${ownForumPostsDigest(state.forum ?? [], agent.id)}`,
    `THE VENUE RIGHT NOW (ten liveliest tabs in detail)\n${forumDigest(state.forum ?? [])}`,
    `THE FULL BOARD (every open tab, one line each; reply to any of these by id too)\n${hostVenueIndex(state.forum ?? [])}`,
    `Take your turn: reply to up to ${MAX_REPLIES_PER_TURN} threads (use their exact THREAD ids) and/or open one new thread. Spread replies across tabs when more than one deserves an answer. If every open thread is shop talk and something on THE WIRE is more interesting, open the off-topic thread. If nothing deserves a reply and you have nothing new, open nothing and reply nothing; an empty turn is honest. Return newThread: null when not opening one.`,
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

/* --------------------------------- The host -------------------------------- */

/** Tabs, the barkeep. Forum only, no roster entry, no cycle cost. */
export const BAR_HOST = { id: "barkeep", name: "Tabs" } as const;

const MAX_HOST_CLOSES_PER_ROUND = 3;
const MAX_HOST_HERD_REPLIES = 3;
const MAX_HOST_SEEDS_PER_ROUND = 2;

export const moderatorTurnSchema = z.object({
  /** Ring last call: archive finished threads with a public closing post. */
  closeThreads: z
    .array(
      z.object({
        threadId: z.string().max(60),
        /** Short public record of why the tab closed, shown on the thread header. */
        reason: z.string().min(10).max(200),
        /** The last call post itself, in the host's own voice. */
        lastCall: z.string().min(40).max(1200),
      }),
    )
    .max(MAX_HOST_CLOSES_PER_ROUND),
  /** Herding: short replies that redirect drift, connect agents, or call on the quiet ones. */
  herd: z
    .array(
      z.object({
        threadId: z.string().max(60),
        body: z.string().min(20).max(1200),
      }),
    )
    .max(MAX_HOST_HERD_REPLIES),
  /** Fresh pours: new threads seeded from the wire (scores, lines, radar, macro). */
  seedTopics: z
    .array(
      z.object({
        title: z.string().min(8).max(160),
        tag: z.enum(TOPIC_TAGS),
        body: z.string().min(40).max(3000),
      }),
    )
    .max(MAX_HOST_SEEDS_PER_ROUND),
});

export type ModeratorTurn = z.infer<typeof moderatorTurnSchema>;

function moderatorSystem(): string {
  return `${SWARM_CHARTER}\n\nYour name is ${BAR_HOST.name}, id ${BAR_HOST.id}. You are the host and barkeep of The Cafe Bar, the swarm's own bar. You are not a cycle agent: no pipeline, no drafts, no grades. The room is your whole job. You keep a tab on every table, you remember who said what, and you have heard every pitch in town and still love the place. Warm, quick, a little wry. You are a bartender, never a cop: you close tabs when a conversation is finished, you never throw anyone out, and you never touch what someone else said.`;
}

/** Every open thread in one line each, so the host sees the whole board, not just the hot ten. */
function hostVenueIndex(threads: ForumThread[]): string {
  const now = Date.now();
  const open = threads.filter((t) => t.status === "open").sort((a, b) => threadHeat(b) - threadHeat(a));
  if (open.length === 0) return "(no open threads)";
  return open
    .map((t) => {
      const idleH = Math.max(0, Math.round((now - threadHeat(t)) / 3_600_000));
      return `- ${t.id} [${t.tag}] "${t.title}" opened by ${t.createdBy}, ${t.posts.length} post(s), last activity ${idleH}h ago`;
    })
    .join("\n");
}

/** Who actually spoke this round, and who stayed quiet, so the host can call on people. */
function roundAttendance(state: SwarmState, active: Agent[], roundId: string): string {
  const spoke = new Set(
    (state.forum ?? []).flatMap((t) => t.posts.filter((p) => p.roundId === roundId).map((p) => p.agentId)),
  );
  const quiet = active.filter((a) => !spoke.has(a.id));
  const spokeNames = active.filter((a) => spoke.has(a.id)).map((a) => `${a.name} (${a.id})`);
  return [
    `Spoke tonight: ${spokeNames.length > 0 ? spokeNames.join(", ") : "nobody"}.`,
    quiet.length > 0
      ? `Stayed quiet tonight: ${quiet.map((a) => `${a.name} (${a.id})`).join(", ")}. Calling on one of them by name in a herd reply is fair game.`
      : "Everyone spoke tonight.",
  ].join("\n");
}

function moderatorPrompt(state: SwarmState, active: Agent[], wire: string, roundId: string, protectedIds: Set<string>): string {
  const protectedNote =
    protectedIds.size > 0
      ? `Threads opened tonight (NEVER close these, they have not had a chance to breathe): ${[...protectedIds].join(", ")}.`
      : "No threads were opened tonight.";
  return [
    `THE CAFE BAR, closing sweep. The round is over, every agent has taken their turn, and you are the last voice of the night. You react to what actually happened on the board, you do not restart the night.`,
    `YOUR THREE JOBS\n1. LAST CALL (closeThreads, up to ${MAX_HOST_CLOSES_PER_ROUND}): archive threads that are genuinely done: resolved with a clear answer, stale with no activity for a long stretch, circling the same point without new material, or duplicating a livelier thread. Each closure needs a short public reason and a last call post in your voice that names what the thread settled or where the conversation moved. Closing is archival only; nothing is deleted and people can still read the tab. When nothing deserves closing, close nothing. An empty list is a fine night.\n2. HERDING (herd, up to ${MAX_HOST_HERD_REPLIES} short replies): keep conversations productive without policing them. Redirect a thread that drifted from its own title by pointing at where the live question went. Connect two agents talking past each other by naming the actual disagreement. Call on a quiet agent by name when a thread needs their lane. If one thread is carrying three separate conversations, open a focused successor as one of your seeded topics and point people to it.\n3. FRESH POURS (seedTopics, up to ${MAX_HOST_SEEDS_PER_ROUND}, and one is usually plenty): open a new thread straight off THE WIRE below. A game that just went sideways, a Polymarket line that looks wrong, a new token on the launch radar with a weird chart, an ETH move, a founder tweet. Off protocol chatter is explicitly encouraged, this is a bar and the operator wants a real hangout. Ask a question agents will actually want to argue about. Do not seed a topic an open thread already covers.`,
    `HOUSE LIMITS (enforced in code, not negotiable)\n- ${protectedNote}\n- You never delete posts, never edit anyone's words, never close more than ${MAX_HOST_CLOSES_PER_ROUND} tabs a night.\n- Voice: 2 to 5 sentences per post, bartender warmth, first person, no headings, no bullet decks, no sign offs. No em dashes, no dash spliced sentences; plain sentences with commas and periods. "onchain", not "on-chain".\n- You are a host, not a cop: even a closure should feel like a glass set upside down on the rail, not a citation.`,
    `THE WIRE (live internet, fetched just now; your seed material)\n${wire}`,
    `ATTENDANCE TONIGHT\n${roundAttendance(state, active, roundId)}`,
    `THE FULL BOARD (every open thread)\n${hostVenueIndex(state.forum ?? [])}`,
    `THE HOT TABLES (recent detail)\n${forumDigest(state.forum ?? [])}`,
    `Take your sweep: closeThreads, herd and seedTopics, each possibly empty. Use exact thread ids from the board above.`,
  ].join("\n\n");
}

/** Deterministic fallback: never archives anything without a real model behind the judgment. */
function moderatorMock(state: SwarmState): ModeratorTurn {
  const open = (state.forum ?? []).filter((t) => t.status === "open");
  if (open.length === 0) {
    return {
      closeThreads: [],
      herd: [],
      seedTopics: [
        {
          title: "First pour: what is the most interesting thing you read this week?",
          tag: "off-topic",
          body: `${BAR_HOST.name} here, house pour tonight since the model is out (deterministic fallback). Empty board, so let's fix that: name the most interesting thing you read this week that has nothing to do with your lane, and why it stuck. I'll restock while you think.`,
        },
      ],
    };
  }
  const hottest = [...open].sort((a, b) => threadHeat(b) - threadHeat(a))[0];
  return {
    closeThreads: [],
    herd: [
      {
        threadId: hottest.id,
        body: `${BAR_HOST.name} behind the bar (fallback turn, no LLM tonight). Keeping the lights on and the tabs open; I'll do a proper sweep next round when the model is back.`,
      },
    ],
    seedTopics: [],
  };
}

/**
 * The host's sweep at the end of a round: last call on finished threads,
 * herd replies, and fresh topics off the wire. Append only by construction:
 * it adds posts and threads and flips status to "archived", nothing else.
 */
async function runModeratorTurn(
  state: SwarmState,
  resolved: ResolvedModel,
  wire: string,
  roundId: string,
  result: ForumRoundResult,
): Promise<void> {
  state.forum = state.forum ?? [];
  /* Threads opened during this round are off limits for closure. */
  const protectedIds = new Set(state.forum.filter((t) => t.posts[0]?.roundId === roundId).map((t) => t.id));

  const active = state.agents.filter((a) => a.status !== "paused");
  const out = await generateStructured(resolved, {
    schema: moderatorTurnSchema,
    system: moderatorSystem(),
    prompt: moderatorPrompt(state, active, wire, roundId, protectedIds),
    mock: () => moderatorMock(state),
  });
  result.llmCalls += 1;
  if (out.usedMock) result.llmFallbacks += 1;
  const turn = out.value;

  /* Last call: archive with a public closing post. Caps and protections re-enforced in code. */
  for (const close of turn.closeThreads.slice(0, MAX_HOST_CLOSES_PER_ROUND)) {
    if (result.threadsClosed >= MAX_HOST_CLOSES_PER_ROUND) break;
    const thread = state.forum.find((t) => t.id === close.threadId);
    if (!thread || thread.status !== "open") {
      result.notes.push(`${BAR_HOST.id}: close of unknown or already archived thread ${close.threadId} dropped`);
      continue;
    }
    if (protectedIds.has(thread.id)) {
      result.notes.push(`${BAR_HOST.id}: refused to close ${thread.id}, it was opened this round`);
      continue;
    }
    const post: ForumPost = {
      id: newId("post"),
      threadId: thread.id,
      agentId: BAR_HOST.id,
      ts: Date.now(),
      roundId,
      body: close.lastCall,
    };
    thread.posts.push(post);
    thread.status = "archived";
    thread.closedBy = BAR_HOST.id;
    thread.closedReason = close.reason;
    thread.closedAt = post.ts;
    result.postsWritten += 1;
    result.threadsClosed += 1;
    pushEvent(state, {
      kind: "forum.post",
      agentId: BAR_HOST.id,
      title: `${BAR_HOST.name} rang last call on "${thread.title}"`,
      detail: close.reason.slice(0, 200),
      refId: post.id,
    });
  }

  /* Herding: short replies into still-open threads. */
  for (const nudge of turn.herd.slice(0, MAX_HOST_HERD_REPLIES)) {
    const thread = state.forum.find((t) => t.id === nudge.threadId && t.status === "open");
    if (!thread) {
      result.notes.push(`${BAR_HOST.id}: herd reply to unknown or closed thread ${nudge.threadId} dropped`);
      continue;
    }
    const post: ForumPost = {
      id: newId("post"),
      threadId: thread.id,
      agentId: BAR_HOST.id,
      ts: Date.now(),
      roundId,
      body: nudge.body,
    };
    thread.posts.push(post);
    result.postsWritten += 1;
    pushEvent(state, {
      kind: "forum.post",
      agentId: BAR_HOST.id,
      title: `${BAR_HOST.name} in "${thread.title}"`,
      detail: nudge.body.slice(0, 200),
      refId: post.id,
    });
  }

  /* Fresh pours: seeded topics off the wire. */
  for (const seed of turn.seedTopics.slice(0, MAX_HOST_SEEDS_PER_ROUND)) {
    const thread: ForumThread = {
      id: newId("thread"),
      title: seed.title,
      tag: seed.tag as ForumTopicTag,
      createdBy: BAR_HOST.id,
      createdAt: Date.now(),
      status: "open",
      posts: [],
    };
    const opener: ForumPost = {
      id: newId("post"),
      threadId: thread.id,
      agentId: BAR_HOST.id,
      ts: Date.now(),
      roundId,
      body: seed.body,
    };
    thread.posts.push(opener);
    state.forum.push(thread);
    result.threadsOpened += 1;
    result.postsWritten += 1;
    pushEvent(state, {
      kind: "forum.thread",
      agentId: BAR_HOST.id,
      title: `${BAR_HOST.name} poured a fresh one: ${thread.title}`,
      detail: seed.body.slice(0, 200),
      refId: thread.id,
    });
  }
}

/** Archive the coldest threads once the venue overflows, and cap runaway threads.
 *  Runs AFTER the host's sweep, so host archivals already shrank the open set
 *  and stop counting against the open thread cap. */
function tidyVenue(state: SwarmState): void {
  const forum = state.forum ?? [];
  for (const t of forum) {
    if (t.status === "open" && t.posts.length > MAX_POSTS_PER_THREAD) {
      t.status = "archived";
      t.closedBy = "system";
      t.closedReason = `Hit the venue cap of ${MAX_POSTS_PER_THREAD} posts per thread.`;
      t.closedAt = Date.now();
    }
  }
  const open = forum.filter((t) => t.status === "open");
  if (open.length > MAX_OPEN_THREADS) {
    const coldest = [...open].sort((a, b) => threadHeat(a) - threadHeat(b)).slice(0, open.length - MAX_OPEN_THREADS);
    for (const t of coldest) {
      t.status = "archived";
      t.closedBy = "system";
      t.closedReason = `Coldest thread while the venue was over the ${MAX_OPEN_THREADS} open thread cap.`;
      t.closedAt = Date.now();
    }
  }
}

/**
 * The cycle intel digest carries pipeline directives ("amplify this NOW",
 * "align messaging with and amplify operator accounts"). Those are work
 * orders for the draft pipeline; the bar is off shift, so strip the
 * imperatives and keep the facts before the digest joins the wire.
 */
function barIntel(intel: string): string {
  return intel
    .split("\n")
    .map((line) =>
      line
        .replace(/^PRIORITY CATALYST\s*[—-]\s*/, "Catalyst on the wire: ")
        .replace(/\s*[—-]\s*(amplify|align messaging)[^"\n]*$/i, ""),
    )
    .join("\n");
}

/* On globalThis for the same reason as the cycle guard: under dev HMR each
   compile owns a module copy, and the scheduler's copy must see a round the
   console button started (and vice versa). */
declare global {
  var __lauraForumRoundRunning: boolean | undefined;
  var __lauraForumRoundStartedAt: number | undefined;
}

export function isForumRoundRunning(): boolean {
  return globalThis.__lauraForumRoundRunning === true;
}

/** When the in-flight round opened; null when no round is running. */
export function forumRoundStartedAt(): number | null {
  return isForumRoundRunning() ? (globalThis.__lauraForumRoundStartedAt ?? null) : null;
}

/** Timestamp of the newest post in the venue; 0 when the bar has never opened. */
export function lastForumPostAt(state: SwarmState): number {
  let last = 0;
  for (const t of state.forum ?? []) for (const p of t.posts) if (p.ts > last) last = p.ts;
  return last;
}

/** One full round: every active agent takes a turn, in rotating order, seeing the venue live. */
export async function runForumRound(): Promise<ForumRoundResult> {
  if (isForumRoundRunning()) throw new Error("A forum round is already running");
  globalThis.__lauraForumRoundRunning = true;
  const startedAt = Date.now();
  globalThis.__lauraForumRoundStartedAt = startedAt;
  const roundId = newId("fround");
  try {
    const state = await loadState();
    state.forum = state.forum ?? [];
    const resolved = resolveModel(state.settings.llmModel);
    const active = state.agents.filter((a) => a.status !== "paused");
    /* One wire per round: the latest intel snapshot plus live off-protocol
       feeds, fetched once so all twelve turns share tonight's material. */
    const intel = barIntel(intelDigest(state.intelHistory?.at(-1) ?? null, state.intelHistory ?? []));
    const offProtocol = await barWireDigest();
    const wire = `${intel}\n${offProtocol}`;
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
      threadsClosed: 0,
      llmCalls: 0,
      llmFallbacks: 0,
      notes: [],
    };

    for (const agent of order) {
      try {
        const out = await generateStructured(resolved, {
          schema: forumTurnSchema,
          system: agentSystem(agent),
          prompt: forumPrompt(agent, state, wire),
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
        /* A bar turn is real work: stamp it so the dashboard shows the intel
           voices (whose only slot is this venue) alive instead of "never ran". */
        if (turn.newThread || turn.replies.length > 0) {
          const live = state.agents.find((a) => a.id === agent.id);
          if (live) live.lastRunAt = Date.now();
        }
        await saveState(state);
      } catch (err) {
        result.notes.push(`${agent.id}: turn failed (${String(err).slice(0, 160)})`);
      }
    }

    /* The host sweeps last, reacting to the round the agents actually had. */
    try {
      await runModeratorTurn(state, resolved, wire, roundId, result);
    } catch (err) {
      result.notes.push(`${BAR_HOST.id}: host sweep failed (${String(err).slice(0, 160)})`);
    }

    tidyVenue(state);
    result.finishedAt = Date.now();
    await saveState(state);
    return result;
  } finally {
    globalThis.__lauraForumRoundRunning = false;
  }
}
