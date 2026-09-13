import { z } from "zod";
import { TWEET_MAX, X_STYLE_GUIDE, acceptAuditEdit, sanitizeXPost } from "@/lib/publish/x-style";
import type { XPostLogEntry } from "@/lib/publish/x-guard";
import { pushEvent } from "@/lib/store";
import type { Draft, SwarmState } from "@/lib/types";

/**
 * Redline, the readability editor for the X account.
 *
 * Why it exists (operator directive 2026-09-13): the 00:05 UTC post read
 * "skip the third call and the sale clock never starts ... 24 launches
 * indexed in the 24h to 21:58 utc, 1089 to 1113 on brokertools.info". Every
 * gate passed it: the style checks saw no label and no repeat, the Auditor
 * saw fresh numbers, the producer's rationale explained the "third call". A
 * human on X saw none of that and could not tell what the post was about.
 * The producer wrote for the pipeline, not for the reader.
 *
 * Redline reads every X-bound post cold, the way a stranger would, and either
 * passes it, rewrites it into plain human language using ONLY the facts
 * already in it (verified in code: no new statistic, link or handle), or holds
 * it when no rewrite can save it. Every rewrite keeps the producer's original
 * on the draft so the producer sees the before/after next cycle and learns.
 *
 * The rail refuses to post anything Redline has not read.
 */

export const editorVerdictSchema = z.object({
  draftId: z.string(),
  verdict: z.enum(["pass", "rewrite", "hold"]),
  /** What a stranger could not follow (rewrite/hold), or what makes it land (pass). */
  reason: z.string().max(700),
  /** The rewritten post for verdict "rewrite"; null otherwise. */
  rewrite: z.string().max(TWEET_MAX).nullable(),
  /** One transferable lesson for the producer, written as an instruction (rewrite/hold only). */
  lesson: z.string().max(300).nullable(),
});

export const editorSchema = z.object({
  reviews: z.array(editorVerdictSchema).max(12),
});

export type EditorOut = z.infer<typeof editorSchema>;

/**
 * Pipeline vocabulary that only makes sense with the rationale beside it.
 * A post carrying any of these is sent to Redline as a rewrite candidate
 * even when the model would otherwise pass it, and the rail refuses it if
 * Redline is offline.
 */
const JARGON_RE =
  /\b(?:experiment\s*\d+|exp\s*\d+|the\s+(?:price|revenue|volume)\s+lever|chain\s+alpha|assigned\s+lane|my\s+lane|resubmitted|the\s+spine|third\s+call|sale\s+clock|from-to\s+pair|delta\s+note|desk\s+note|veto(?:ed)?|the\s+auditor|the\s+reviewer|run_[0-9a-f]{6,}|draft_[0-9a-f]{6,})\b/i;

/** Two bare integers joined by "to" with no unit word around them: a counter, not a fact ("1089 to 1113"). */
const BARE_COUNTER_RE = /(?<![$\w])\d{3,}\s+to\s+\d{3,}(?!\s*(?:%|k\b|m\b|b\b|x\b|eth|usd|holders?|wallets?|tokens?|launches|trades|pools?|\$))/i;

/**
 * Deterministic readability problems: the parts of "a stranger can follow
 * this" a regex can see. Everything else is Redline's call.
 */
export function readabilityProblems(text: string): string[] {
  const t = text.trim();
  const problems: string[] = [];
  const jargon = t.match(JARGON_RE);
  if (jargon) problems.push(`pipeline jargon a reader cannot decode ("${jargon[0]}")`);
  if (BARE_COUNTER_RE.test(t)) problems.push("a bare counter range with no unit (e.g. \"1089 to 1113\")");
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 8) problems.push("too short to carry a subject and a point");
  const subject =
    /\b(?:stonk\w*|\$?stonkbroker\w*|robinhood|launcher|launchpad|broker\w*|clock\s*in|anvil|vdex|smart\s*lp|laura|stock\s*tokens?|tokenized|dex|pool|liquidity|holders?|wallets?|fees?|volume|mcap|market\s*cap|eth|weth|usdg|\$[a-z]{2,10})\b/i;
  if (!subject.test(t)) problems.push("names no subject a reader would recognise (a product, a chain, a token, a market number)");
  return problems;
}

export function isXPost(d: Draft): boolean {
  return d.kind === "post" && /^(x|twitter)$/i.test(d.channel.trim());
}

export function editorPrompt(input: { drafts: Draft[]; recent: XPostLogEntry[]; today: string }): string {
  const recent = input.recent
    .slice(0, 6)
    .map((e) => `- ${sanitizeXPost(e.text).text.replace(/\s+/g, " ").slice(0, 240)}`)
    .join("\n");
  const drafts = input.drafts
    .map((d) => {
      const flags = readabilityProblems(d.body);
      return `DRAFT ${d.id} (by ${d.agentId}, ${d.body.length} chars)${flags.length ? `\nCODE FLAGS: ${flags.join("; ")}` : ""}\n${d.body}\n(producer's private rationale, the reader never sees it: ${d.rationale.replace(/\s+/g, " ").slice(0, 320)})`;
    })
    .join("\n\n");
  return [
    `TODAY (UTC): ${input.today}.`,
    `You are Redline, the readability editor for the @LAURA_DAIO X account. The posts below were written by agents who read a dense internal briefing and then wrote for that briefing instead of for a person. You read each post COLD, as a stranger on X who follows crypto and maybe Robinhood Chain, has never seen the rationale, and gives the post three seconds.`,
    `THE READER TEST, apply it literally to every post: (1) After the first sentence, can the reader say in plain words what this post is about? (2) Does every number carry a unit and a referent a human uses (dollars, ETH, holders, launches, percent, a date), never a bare counter like "1089 to 1113" or a pipeline label like "Experiment 56"? (3) Is there any word that only the pipeline understands: "third call", "sale clock", "proxy", "lever", "lane", "resubmitted", "the spine", "this cycle", "vetoed"? (4) Does the reader walk away with one concrete thing about StonkBrokers, Robinhood Chain, a launch, a market or LAURA's own onchain moves that they did not know, or one clear view they can agree or disagree with? (5) Would a human read it and think a person who knows the chain wrote it, in complete thoughts?`,
    `VERDICTS. "pass": all five hold; say in one clause what lands. "rewrite": the facts are good but the post fails 1, 2, 3 or 5; return the post rewritten in plain language that a newcomer follows, keeping the voice (lowercase aixbt style or a plain declarative both fine), at most ${TWEET_MAX} characters, using ONLY facts, numbers, names and links already in the post. You may add ordinary words that explain what a number is ("launches on the Stonk Launcher", "a token that finished its curve") and you may delete anything. You may NOT add a new number, a new claim, a link or a handle; code checks every statistic against the original and drops the rewrite if one is new. "hold": the post cannot be understood without facts it does not contain, or it carries no takeaway at all; explain exactly what a stranger cannot follow. Holds are common and correct; a silent account beats a confusing one.`,
    `For every rewrite or hold also write ONE lesson for the producer as an instruction it can follow next time (e.g. "Name the product in the first six words before any number", "A count of launches needs the word launches after it and the venue it happened on").`,
    X_STYLE_GUIDE,
    `RECENTLY POSTED FROM THE ACCOUNT (context for voice; do not rewrite anything into an echo of these)\n${recent || "Nothing posted yet."}`,
    `POSTS TO EDIT\n\n${drafts}`,
    `Return one review per draft id, in the same order.`,
  ].join("\n\n");
}

/** Fallback with no live model: never pass unread; a code-flagged post is held, the rest wait. */
export function editorMock(drafts: Draft[]): EditorOut {
  return {
    reviews: drafts.map((d) => {
      const flags = readabilityProblems(d.body);
      return flags.length > 0
        ? {
            draftId: d.id,
            verdict: "hold" as const,
            reason: `Deterministic fallback (no live model): code flags ${flags.join("; ")}`,
            rewrite: null,
            lesson: "Write the post for a stranger: name the product, give every number a unit, drop pipeline words.",
          }
        : {
            draftId: d.id,
            verdict: "pass" as const,
            reason: "Deterministic fallback (no live model): no code-level readability flags; no human read available.",
            rewrite: null,
            lesson: null,
          };
    }),
  };
}

export interface EditorApplyResult {
  passed: number;
  rewritten: number;
  held: number;
  lessons: string[];
}

/**
 * Applies Redline's reviews to drafts in place (caller saves state). A
 * rewrite that adds a statistic, link or handle the original lacked is
 * refused in code and downgraded to a hold with the reason recorded, so a
 * hallucinated number can never ship under the editor's name.
 */
export function applyEditorReviews(
  state: SwarmState,
  drafts: Draft[],
  out: EditorOut,
  usedMock: boolean,
): EditorApplyResult {
  const result: EditorApplyResult = { passed: 0, rewritten: 0, held: 0, lessons: [] };
  const hold = (draft: Draft, reason: string, lesson: string | null) => {
    const wasApproved = draft.status === "approved";
    draft.status = "rejected";
    draft.reviewedAt = Date.now();
    draft.reviewerNote = `Editor hold (Redline): ${reason}${lesson ? ` · Lesson: ${lesson}` : ""}`;
    draft.editorVerdict = "hold";
    draft.editorNote = reason;
    draft.autoPublishNote = `held by the editor: ${reason.slice(0, 200)}`;
    const author = state.agents.find((a) => a.id === draft.agentId);
    if (author) {
      author.stats.rejected += 1;
      if (wasApproved && author.stats.approved > 0) author.stats.approved -= 1;
    }
    result.held += 1;
    if (lesson) result.lessons.push(lesson);
    pushEvent(state, {
      kind: "editor.held",
      agentId: "editor",
      title: `Redline held an X post by ${draft.agentId}: ${draft.title}`,
      detail: `${reason}${lesson ? `\nLesson for the producer: ${lesson}` : ""}\nPost: ${draft.body.slice(0, 280)}`,
      refId: draft.id,
    });
  };
  for (const draft of drafts) {
    const review = out.reviews.find((r) => r.draftId === draft.id);
    if (!review) {
      /* Unreviewed by the model: a code-flagged post is held, a clean one waits for the gate read. */
      const flags = readabilityProblems(draft.body);
      if (flags.length > 0) hold(draft, `not reviewed by the editor and code flags: ${flags.join("; ")}`, null);
      continue;
    }
    if (review.verdict === "pass") {
      if (usedMock) continue; // the gate will read it with a live model
      draft.editorVerdict = "pass";
      draft.editorNote = review.reason;
      result.passed += 1;
      continue;
    }
    if (review.verdict === "hold") {
      hold(draft, review.reason, review.lesson);
      continue;
    }
    const accepted = acceptAuditEdit(draft.body, review.rewrite);
    if (!accepted) {
      hold(
        draft,
        `${review.reason} (the editor's rewrite was refused in code because it introduced a statistic, link or handle the original did not have)`,
        review.lesson,
      );
      continue;
    }
    const before = draft.body;
    draft.originalBody = before;
    draft.body = accepted;
    draft.editorVerdict = "rewrite";
    draft.editorNote = review.reason;
    draft.rationale = `${draft.rationale}\n\nRedline rewrite (${review.reason.slice(0, 200)}). Original: ${before}`;
    result.rewritten += 1;
    if (review.lesson) result.lessons.push(review.lesson);
    pushEvent(state, {
      kind: "editor.rewrote",
      agentId: "editor",
      title: `Redline rewrote an X post by ${draft.agentId}: ${draft.title}`,
      detail: `${review.reason}${review.lesson ? `\nLesson for the producer: ${review.lesson}` : ""}\nBefore: ${before}\nAfter: ${accepted}`,
      refId: draft.id,
    });
  }
  return result;
}

/**
 * What the producer reads next cycle: its own denied and rewritten X posts
 * with the reason, so the same mistake is not made twice.
 */
export function deniedPostsDigest(drafts: Draft[], agentId: string, limit = 6): string {
  const mine = drafts
    .filter((d) => d.agentId === agentId && isXPost(d) && (d.status === "rejected" || d.editorVerdict === "rewrite"))
    .slice(-limit);
  if (mine.length === 0) return "No denied or rewritten X posts on your record yet.";
  return mine
    .map((d) => {
      const when = new Date(d.reviewedAt ?? d.createdAt).toISOString().slice(0, 16).replace("T", " ");
      if (d.editorVerdict === "rewrite" && d.originalBody) {
        return `- ${when} UTC REWRITTEN by Redline: ${d.editorNote ?? ""}\n  you wrote: ${d.originalBody.replace(/\s+/g, " ").slice(0, 240)}\n  it posted as: ${d.body.replace(/\s+/g, " ").slice(0, 240)}`;
      }
      return `- ${when} UTC DENIED: ${(d.reviewerNote ?? "no reason recorded").replace(/\s+/g, " ").slice(0, 320)}\n  the post: ${(d.originalBody ?? d.body).replace(/\s+/g, " ").slice(0, 200)}`;
    })
    .join("\n");
}
