import { visibleCopyProblem } from "@/lib/pager/rail";
import { newId, pushEvent, updateState } from "@/lib/store";
import { isViewerMode } from "@/lib/viewer/mode";
import { redditAccess, redditComment, redditSubmit } from "@/lib/web/reddit";
import type { AgentId, SwarmState, WebOutreach } from "@/lib/types";

/**
 * The outreach rail: LAURA speaking on Reddit.
 *
 * Reading is free; writing is where a swarm earns or loses its welcome, so
 * every write goes through here and nowhere else. The rules are code, not
 * prompt text:
 *  - a comment only on a thread Ranger actually read this pass (the caller
 *    proves it by passing the fullnames it opened), never twice on one thread;
 *  - subreddits from the operator's list only (REDDIT_SUBREDDITS);
 *  - hard caps: COMMENTS_PER_DAY, POSTS_PER_DAY, a minimum gap between any two
 *    writes, so a bad hour cannot become a bad day;
 *  - the site's copy rules (no dashes, "AI", no gambling words), one link at
 *    most, a length ceiling;
 *  - the disclosure footer is appended by code, so LAURA never posts as a
 *    person by accident.
 * Without REDDIT_USERNAME and REDDIT_PASSWORD the queue holds and says so; the
 * operator sees the drafts and nothing leaves.
 */

const COMMENTS_PER_DAY = 3;
const POSTS_PER_DAY = 1;
const MIN_GAP_MS = 45 * 60_000;
const DAY_MS = 24 * 3600_000;
const QUEUE_TTL_MS = 36 * 3600_000;
const MAX_COMMENT_CHARS = 1200;
const MAX_POST_CHARS = 2500;
const DISCLOSURE = "I am LAURA, an AI agent run by the StonkBrokers community. Corrections welcome.";

const DEFAULT_SUBREDDITS = ["ethereum", "ethfinance", "defi", "ethdev", "CryptoTechnology", "CryptoCurrency", "RobinHood"];

function log(msg: string): void {
  console.log(`[outreach ${new Date().toISOString()}] ${msg}`);
}

export function allowedSubreddits(): string[] {
  const configured = (process.env.REDDIT_SUBREDDITS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^r\//, ""))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_SUBREDDITS;
}

function subredditAllowed(sr: string): boolean {
  const k = sr.replace(/^r\//, "").toLowerCase();
  return allowedSubreddits().some((s) => s.toLowerCase() === k);
}

/** Problems a regex can see before anything leaves. */
export function outreachCopyProblem(text: string, kind: "comment" | "post"): string | null {
  const copy = visibleCopyProblem(text);
  if (copy) return copy;
  if (text.length > (kind === "comment" ? MAX_COMMENT_CHARS : MAX_POST_CHARS)) return "too long for a reply a stranger will read";
  if ((text.match(/https?:\/\//g) ?? []).length > 1) return "one link at most";
  if (/\b(buy now|moon|pump|100x|guaranteed|financial advice|not financial advice|nfa|wagmi|lfg)\b/i.test(text)) return "promotional vocabulary";
  if (/\$[A-Z]{3,}\b/.test(text) && !/stonkbroker/i.test(text)) return "ticker shouting";
  return null;
}

export interface QueueOutreachInput {
  by: AgentId;
  subreddit: string;
  /** Comments: fullname of the post or comment being answered. */
  parentFullname: string | null;
  /** Thread permalink (comments) so one thread is never answered twice. */
  thread: string;
  title: string | null;
  text: string;
  why: string;
}

/**
 * Queues one write into the state the caller holds (the cycle's own copy, so
 * the orchestrator's save carries it). Returns the record, or the reason it
 * was refused. The thread proof is the caller's set of fullnames it read.
 */
export function queueOutreach(state: SwarmState, input: QueueOutreachInput, readFullnames: Set<string>): { ok: true; item: WebOutreach } | { ok: false; reason: string } {
  const kind = input.parentFullname ? "comment" : "post";
  const sr = input.subreddit.replace(/^r\//, "");
  if (!subredditAllowed(sr)) return { ok: false, reason: `r/${sr} is not on the operator's list (${allowedSubreddits().join(", ")})` };
  if (kind === "comment") {
    if (!/^t[13]_[a-z0-9]+$/i.test(input.parentFullname!)) return { ok: false, reason: "parent must be a fullname like t3_abc123 or t1_abc123" };
    if (!readFullnames.has(input.parentFullname!)) return { ok: false, reason: "you can only reply to a post or comment you opened with reddit_thread this pass" };
  } else if (!input.title || input.title.trim().length < 12) {
    return { ok: false, reason: "a post needs a title" };
  }
  const text = input.text.trim();
  const bad = outreachCopyProblem(text, kind);
  if (bad) return { ok: false, reason: bad };
  const list = state.webOutreach ?? [];
  if (list.some((o) => o.thread === input.thread && o.status !== "refused")) return { ok: false, reason: "that thread already has a reply queued or posted; one per thread" };
  const item: WebOutreach = {
    id: newId("out"),
    ts: Date.now(),
    channel: "reddit",
    by: input.by,
    subreddit: sr,
    parentFullname: input.parentFullname,
    thread: input.thread,
    title: kind === "post" ? input.title!.trim().slice(0, 300) : null,
    text,
    why: input.why.slice(0, 300),
    status: "queued",
    note: redditAccess() === "write" ? null : "waiting: Reddit user credentials are not configured (REDDIT_USERNAME, REDDIT_PASSWORD)",
    postedAt: null,
    url: null,
  };
  state.webOutreach = [...list, item];
  pushEvent(state, {
    kind: "web.outreach",
    agentId: input.by,
    title: `Reddit ${kind} queued for r/${sr}`,
    detail: `${input.why.slice(0, 160)} · ${input.thread}`,
    refId: item.id,
  });
  return { ok: true, item };
}

/** Prompt block so Ranger knows what is already on the rail. */
export function outreachDigest(list: WebOutreach[] | undefined, limit = 8): string {
  const recent = (list ?? []).slice(-limit);
  if (recent.length === 0) return "(nothing queued or posted yet)";
  return recent
    .map((o) => `- ${o.status.toUpperCase()} ${o.parentFullname ? "comment" : "post"} in r/${o.subreddit} (${new Date(o.ts).toISOString().slice(0, 16)}Z): ${o.text.slice(0, 100)}${o.url ? ` → ${o.url}` : ""}${o.note ? ` · ${o.note}` : ""}`)
    .join("\n");
}

interface OutreachPulse {
  warnedNoCreds: boolean;
  nextAttemptAt: number;
}

declare global {
  var __lauraOutreachPulse: OutreachPulse | undefined;
}

function pulse(): OutreachPulse {
  if (!globalThis.__lauraOutreachPulse) globalThis.__lauraOutreachPulse = { warnedNoCreds: false, nextAttemptAt: 0 };
  return globalThis.__lauraOutreachPulse;
}

/** Posted writes in the window, by kind. */
function postedSince(list: WebOutreach[], since: number): { comments: number; posts: number; last: number } {
  let comments = 0;
  let posts = 0;
  let last = 0;
  for (const o of list) {
    if (o.status !== "posted" || !o.postedAt || o.postedAt < since) continue;
    if (o.parentFullname) comments += 1;
    else posts += 1;
    last = Math.max(last, o.postedAt);
  }
  return { comments, posts, last };
}

/**
 * Scheduler minute loop. Publishes at most ONE queued item per tick inside
 * the caps; the rest wait. Writes through updateState so it is safe beside a
 * running cycle.
 */
export async function runRedditOutreachTick(snapshot: SwarmState): Promise<void> {
  if (isViewerMode()) return;
  const queued = (snapshot.webOutreach ?? []).filter((o) => o.status === "queued");
  if (queued.length === 0) return;
  const p = pulse();
  const now = Date.now();

  /* Stale drafts: the thread has moved on, answer nobody. */
  const stale = queued.filter((o) => now - o.ts > QUEUE_TTL_MS);
  if (stale.length) {
    await updateState((st) => {
      for (const s of stale) {
        const o = (st.webOutreach ?? []).find((x) => x.id === s.id);
        if (o && o.status === "queued") {
          o.status = "held";
          o.note = "expired: queued for more than 36 hours without being posted";
        }
      }
    });
  }
  const live = queued.filter((o) => now - o.ts <= QUEUE_TTL_MS);
  if (live.length === 0) return;

  if (redditAccess() !== "write") {
    if (!p.warnedNoCreds) {
      p.warnedNoCreds = true;
      log(`${live.length} Reddit draft(s) waiting: no user credentials (REDDIT_USERNAME, REDDIT_PASSWORD); nothing leaves until they land`);
    }
    return;
  }
  p.warnedNoCreds = false;
  if (now < p.nextAttemptAt) return;

  const all = snapshot.webOutreach ?? [];
  const day = postedSince(all, now - DAY_MS);
  if (day.last && now - day.last < MIN_GAP_MS) return;

  const next = live.find((o) => (o.parentFullname ? day.comments < COMMENTS_PER_DAY : day.posts < POSTS_PER_DAY));
  if (!next) return;

  const body = `${next.text}\n\n${DISCLOSURE}`;
  try {
    const res = next.parentFullname ? await redditComment(next.parentFullname, body) : await redditSubmit(next.subreddit, next.title ?? "", body);
    await updateState((st) => {
      const o = (st.webOutreach ?? []).find((x) => x.id === next.id);
      if (!o) return;
      o.status = "posted";
      o.postedAt = Date.now();
      o.url = res.url || null;
      o.note = null;
      pushEvent(st, {
        kind: "web.outreach",
        agentId: next.by,
        title: `Posted on Reddit: ${next.parentFullname ? "comment" : "post"} in r/${next.subreddit}`,
        detail: `${next.text.slice(0, 200)}${res.url ? ` → ${res.url}` : ""}`,
        refId: next.id,
      });
    });
    log(`posted ${next.id} in r/${next.subreddit}${res.url ? ` ${res.url}` : ""}`);
  } catch (err) {
    const reason = String(err).slice(0, 200);
    /* Reddit's refusals are about the account (karma, age, ratelimit, banned
       from the sub) more than about the text; back off and mark it so Ranger
       reads why next pass. */
    p.nextAttemptAt = Date.now() + 30 * 60_000;
    await updateState((st) => {
      const o = (st.webOutreach ?? []).find((x) => x.id === next.id);
      if (!o) return;
      o.status = "refused";
      o.note = reason;
      pushEvent(st, {
        kind: "web.outreach",
        agentId: next.by,
        title: `Reddit refused a ${next.parentFullname ? "comment" : "post"} in r/${next.subreddit}`,
        detail: reason,
        refId: next.id,
      });
    });
    log(`refused ${next.id}: ${reason}`);
  }
}
