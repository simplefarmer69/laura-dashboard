import { z } from "zod";
import { similarity } from "@/lib/swarm/novelty";
import { metricsLine, xPerformanceDigest } from "@/lib/publish/x-metrics";
import type { XPostLogEntry } from "@/lib/publish/x-guard";

/**
 * House style for LAURA's X posts, plus the code-level checks that enforce
 * the parts of it a regex can see.
 *
 * Distilled 2026-09-12 from a read of ~180 recent originals by the accounts
 * the operator named as references (@aixbt_agent, @vladtenev,
 * @JohannKerbrat, @elonmusk, @OxSimpleFarmer). What they share: one idea per
 * post, no thread numbering, no hashtags, no self-introduction, no
 * boilerplate opener or sign-off, concrete numbers with dates, and a length
 * that fits the thought (aixbt fills 280 with dense facts; Vlad and Johann
 * average 110 to 140 characters; Musk averages 60). None of them ever
 * announce that a post is "content" or who it is "by".
 */

export const TWEET_MAX = 280;

export const X_STYLE_GUIDE = [
  `WRITING FOR X (house style, distilled from @aixbt_agent, @vladtenev, @JohannKerbrat, @elonmusk and @OxSimpleFarmer):`,
  `- ONE post, ONE idea, at most ${TWEET_MAX} characters. Never a thread, never "1/", never "🧵", never "(cont.)". If the idea needs more room it is two ideas; keep the sharper one.`,
  `- Never open with a label. No "Official StonkBrokers content", no "LAURA here", no "As an AI agent", no "Update:", no "Thread:", no date stamp, no title. The first words are already the point.`,
  `- Never close with a label. No "Docs:", no "Not financial advice", no "not open to US persons", no "fee-funded, not a dividend" tacked on. No disclaimers, no risk boilerplate, no disclosures about what LAURA is. The post ends when the thought ends.`,
  `- Sound like a person who knows the chain. aixbt's template: lead with the thesis as a plain conditional ("if X, Y", "unless X, Y", "as long as X, Y"), then two or three concrete facts with numbers and dates, lowercase, periods, no adjectives. Vlad's template: one confident declarative sentence, a milestone number, sometimes a question. Johann's: a milestone and what it proves ("190+ Stock Tokens, $3B in cumulative volume, and a lot more to build."). Musk's: a short reaction to something real. Simple Farmer's: founder voice, names the product and the pair, invites people to try it.`,
  `- Rotate between those templates and between capitalisation styles across posts. Two consecutive posts must not share an opening word, a sentence shape, a closing phrase or a statistic.`,
  `- No hashtags. No emoji except at most one when it carries the tone. No exclamation marks in a row. No "excited to", "thrilled", "game-changer", "revolutionary", "dive in", "unlock", "leverage", "seamless", "robust". No em dashes. No rhetorical "Here's why" or "Let that sink in" unless quoting.`,
  `- Numbers are the humanity: a real figure from this cycle's data, with its date or window, beats any adjective. Never invent one; never round a figure you were given to a prettier one.`,
  `- Topics people follow this account for: what is actually happening on Robinhood Chain right now (stock tokens, launches, liquidity moves, Vlad and Johann's latest, builders shipping), what LAURA's own wallet did onchain, and the sharpest line from the Cafe Bar debate (quote the agent by name when it is good). Not another explainer of a mechanic the account already explained.`,
  `- Honesty rules still apply: no price predictions, no calls to buy, no return promises, traceable claims only. Speak as LAURA in the first person when the post is about her own moves; never explain or disclose what she is.`,
].join("\n");

/**
 * Boilerplate the swarm drifted into and the operator banned. Stripped from
 * the head and tail of a post before any other check, so a leftover habit
 * costs the label, not the post.
 */
const HEAD_BOILERPLATE: RegExp[] = [
  /^\s*\d{1,2}\s*[/).]\s*/,
  /^\s*(?:🧵|thread:?)\s*/i,
  /^\s*official\s+stonkbrokers?\s+content[^.]*\.?\s*/i,
  /^\s*laura(?:,?\s+an\s+ai\s+agent)?(?:\s+here)?[.:,]\s*/i,
  /^\s*(?:as\s+an\s+ai\s+agent|ai\s+agent\s+update|update|note)[.:,]\s*/i,
  /^\s*follows\s+my\s+approved\s+(?:thread|article|post)\s+'[^']*'\.\s*/i,
];

const TAIL_BOILERPLATE: RegExp[] = [
  /\s*(?:docs|more|details|source|read more):\s*\S+\s*$/i,
  /\s*(?:not\s+financial\s+advice|nfa)\.?\s*$/i,
  /\s*\((?:cont\.?|continued|\d+\/\d+)\)\s*$/i,
  /\s*(?:[^.]*\b(?:not\s+(?:open|available)\s+(?:to|in)\s+(?:the\s+)?(?:us|u\.s\.)(?:\s+persons)?|unavailable\s+(?:in|to)\s+(?:the\s+)?(?:us|u\.s\.|united\s+states)(?:\s+persons)?)[^.]*)\.?\s*$/i,
  /\s*(?:[^.]*\b(?:fee-funded|smart-contract|contract\s+mechanics?)[^.]*\bnot\s+(?:a\s+)?dividends?[^.]*|[^.]*\bnot\s+(?:a\s+)?dividends?(?:\s+or\s+equity)?[^.]*)\.?\s*$/i,
];

/** Disclaimer language the operator retired from posts (2026-09-12). */
const DISCLAIMER_RE =
  /\b(?:not\s+financial\s+advice|nfa|not\s+(?:a\s+)?dividends?(?:\s+or\s+equity)?|(?:us|u\.s\.)\s+persons|unavailable\s+(?:in|to)\s+(?:the\s+)?(?:us|u\.s\.|united\s+states)|not\s+(?:open|available)\s+(?:to|in)\s+(?:the\s+)?(?:us|u\.s\.)\b|as\s+an\s+ai|i\s+am\s+an\s+ai|ai\s+agent)/i;

export interface SanitizedPost {
  text: string;
  /** Human-readable list of what was removed; empty when the body was clean. */
  stripped: string[];
}

/** Removes banned openers and sign-offs, normalises whitespace and dashes. */
export function sanitizeXPost(body: string): SanitizedPost {
  const stripped: string[] = [];
  let text = body.replace(/\r/g, "").trim();
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const re of HEAD_BOILERPLATE) {
      const m = re.exec(text);
      if (m && m[0].length > 0) {
        stripped.push(`opener "${m[0].trim()}"`);
        text = text.slice(m[0].length).trimStart();
        changed = true;
      }
    }
    for (const re of TAIL_BOILERPLATE) {
      const m = re.exec(text);
      if (m && m[0].length > 0) {
        stripped.push(`sign-off "${m[0].trim()}"`);
        text = text.slice(0, m.index).trimEnd();
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (/[—–]/.test(text)) {
    stripped.push("em dash");
    text = text.replace(/\s*[—–]\s*/g, ", ");
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { text, stripped };
}

function firstWords(text: string, n: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$@ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, n)
    .join(" ");
}

function lastWords(text: string, n: number): string {
  const w = text
    .toLowerCase()
    .replace(/[^a-z0-9$@ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return w.slice(Math.max(0, w.length - n)).join(" ");
}

/**
 * Statistics (numbers with optional $, %, k/m/b) quoted in a post. Dates and
 * clock times are not statistics: every post of a day would share them.
 */
export function statsIn(text: string): Set<string> {
  const out = new Set<string>();
  const undated = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  for (const m of undated.matchAll(/\$?\d[\d,]*(?:\.\d+)?%?[kmbx]?/gi)) {
    const v = m[0].replace(/,/g, "").toLowerCase();
    if (v.replace(/[^\d]/g, "").length >= 3) out.add(v);
  }
  return out;
}

/** Overlap above which a post is "repeating things from a previous post". */
export const REPEAT_THRESHOLD = 0.5;

/**
 * Deterministic checks a post must pass before it reaches the auditor. Every
 * violation is collected so the log and the veto note show the full picture.
 */
export function xPostProblems(text: string, recent: XPostLogEntry[]): string[] {
  const problems: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return ["empty body"];
  if (trimmed.length > TWEET_MAX) problems.push(`${trimmed.length} chars; a post is at most ${TWEET_MAX}`);
  if (/\n\s*\n/.test(trimmed) && trimmed.split(/\n\s*\n/).length > 2) problems.push("reads as a thread (several blank-line separated sections)");
  if (/(?:^|\n)\s*\d{1,2}\s*[/)]\s/.test(trimmed) || /\b\d{1,2}\/\d{1,2}\b\s*$/.test(trimmed) || /\n\s*\n/.test(trimmed) && /\n\s*\d{1,2}\s*[/).]/.test(trimmed)) {
    problems.push("thread numbering");
  }
  if (/official\s+stonkbrokers?\s+content/i.test(trimmed)) problems.push('banned opener "Official StonkBrokers content"');
  if (/\b(?:as an ai agent|laura here|i am an ai agent swarm)\b/i.test(trimmed)) problems.push("self-introduction boilerplate");
  if (DISCLAIMER_RE.test(trimmed)) problems.push("disclaimer or disclosure boilerplate");
  if (/[—–]/.test(trimmed)) problems.push("em dash");
  const hashtags = trimmed.match(/(^|\s)#\w+/g)?.length ?? 0;
  if (hashtags > 0) problems.push(`${hashtags} hashtag(s)`);
  const emoji = trimmed.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
  if (emoji > 1) problems.push(`${emoji} emoji`);
  if (/!{2,}/.test(trimmed)) problems.push("stacked exclamation marks");
  if (/\b(?:game[- ]changer|revolutionary|thrilled|excited to|dive in|unlock(?:s|ing)?|leverag(?:e|ing)|seamless|robust)\b/i.test(trimmed)) {
    problems.push("marketing filler word");
  }
  const window = recent.slice(0, 12);
  const open = firstWords(trimmed, 4);
  const close = lastWords(trimmed, 4);
  for (const e of window) {
    const prev = sanitizeXPost(e.text).text;
    if (open.split(" ").length >= 3 && firstWords(prev, 4) === open) {
      problems.push(`opens with the same words as ${e.url}`);
      break;
    }
  }
  for (const e of window) {
    const prev = sanitizeXPost(e.text).text;
    if (close.split(" ").length >= 3 && lastWords(prev, 4) === close) {
      problems.push(`closes with the same words as ${e.url}`);
      break;
    }
  }
  const mine = statsIn(trimmed);
  for (const e of window) {
    const s = similarity(trimmed, e.text);
    if (s >= REPEAT_THRESHOLD) {
      problems.push(`${(s * 100).toFixed(0)}% word overlap with ${e.url}`);
      break;
    }
    if (mine.size >= 2) {
      const theirs = statsIn(e.text);
      let shared = 0;
      for (const v of mine) if (theirs.has(v)) shared += 1;
      if (shared >= 2 && shared >= Math.ceil(mine.size / 2)) {
        problems.push(`repeats ${shared} statistic(s) already posted in ${e.url}`);
        break;
      }
    }
  }
  return problems;
}

/* ------------------------------ Auditor gate ------------------------------ */

export const xAuditSchema = z.object({
  verdict: z.enum(["pass", "veto"]),
  /** For a veto: the specific defect and the passing edit, if any. For a pass: what works.
      Headroom: the Auditor's strategy mandates a verbose veto shape (2026-09-12 probe hit 600). */
  reason: z.string().max(1400),
  /**
   * Optional light edit that passes. Deleting words, fixing punctuation and
   * capitalisation, and cutting length are allowed; adding a fact, a number,
   * a link or a claim is not (enforced in code: every statistic in the edit
   * must already appear in the original).
   */
  edited: z.string().max(TWEET_MAX).nullable(),
});

export type XAuditOut = z.infer<typeof xAuditSchema>;

export function xAuditPrompt(input: {
  post: string;
  author: string;
  rationale: string;
  recent: XPostLogEntry[];
  today: string;
}): string {
  const recent = input.recent
    .slice(0, 10)
    .map((e) => `- (${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")} UTC) ${sanitizeXPost(e.text).text.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return [
    `TODAY (UTC): ${input.today}.`,
    `You are the pre-publish auditor for the @LAURA_DAIO X account. A producer agent (${input.author}) wants to post the text below. Nothing goes out without your pass. You are the last reader before a public audience of traders who can smell a bot.`,
    X_STYLE_GUIDE,
    `VETO when any of these hold: it reads like a template or a press release; it opens or closes with a label, a disclaimer or a sign-off; it is a thread or a numbered fragment; it repeats an opening, a closing, a phrase, a statistic or a theme from the posts below; it explains a mechanic in the abstract instead of saying what happened; it contains a claim with no number, date, source or event behind it; it predicts price, tells people to buy, or promises a return; it uses filler words, hashtags or stacked punctuation; a human reading it would not say "someone wrote this".`,
    `PASS when a human who follows Robinhood Chain would read it, learn one concrete thing, and not notice it was written by an agent. When a light edit (cut words, fix case, drop a label, tighten a clause) turns a near-miss into a pass, return the edit in "edited"; never add a fact, a number, a link or a claim that is not already in the post, and never exceed ${TWEET_MAX} characters.`,
    `ALREADY POSTED FROM THIS ACCOUNT (newest first; the candidate must not echo any of these)\n${recent || "Nothing posted yet."}`,
    `PRODUCER'S RATIONALE (context only, do not judge the rationale)\n${input.rationale.slice(0, 600)}`,
    `CANDIDATE POST (${input.post.length} chars)\n${input.post}`,
  ].join("\n\n");
}

export function xAuditMock(): XAuditOut {
  return {
    verdict: "pass",
    reason: "Deterministic fallback (no LLM key): code-level checks passed; no human-style judgement available.",
    edited: null,
  };
}

/**
 * Checks an auditor edit against the original: same or fewer statistics, no
 * new links or handles, fits a tweet. Returns the text to publish or null
 * when the edit is not acceptable (the original then stands or falls alone).
 */
export function acceptAuditEdit(original: string, edited: string | null): string | null {
  if (!edited) return null;
  const e = sanitizeXPost(edited).text;
  if (e.length === 0 || e.length > TWEET_MAX) return null;
  const origStats = statsIn(original);
  for (const v of statsIn(e)) if (!origStats.has(v)) return null;
  const links = (s: string) => new Set((s.match(/https?:\/\/\S+|\b[\w-]+\.(?:io|cash|com|xyz|fun)\b\S*/gi) ?? []).map((x) => x.toLowerCase()));
  const origLinks = links(original);
  for (const l of links(e)) if (!origLinks.has(l)) return null;
  const handles = (s: string) => new Set((s.match(/@\w+/g) ?? []).map((x) => x.toLowerCase()));
  const origHandles = handles(original);
  for (const h of handles(e)) if (!origHandles.has(h)) return null;
  return e;
}

/**
 * Digest of the account's recent posts for the producer, critic and coach
 * prompts, each with its measured response when a read exists, plus the
 * best/worst ranking so the shape the audience rewarded is visible.
 */
export function recentXPostsDigest(recent: XPostLogEntry[]): string {
  if (recent.length === 0) return "Nothing posted yet from this rail.";
  const posts = recent
    .slice(0, 10)
    .map((e) => {
      const when = new Date(e.at).toISOString().slice(0, 16).replace("T", " ");
      const m = metricsLine(e);
      return `- ${when} UTC: ${sanitizeXPost(e.text).text.replace(/\s+/g, " ").slice(0, 280)}${m ? ` [${m}]` : ""}`;
    })
    .join("\n");
  return `${posts}\nMEASURED RESPONSE\n${xPerformanceDigest(recent)}`;
}
