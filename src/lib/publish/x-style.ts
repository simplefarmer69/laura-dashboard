import { z } from "zod";
import { REPEAT_MIN_SHARED_WORDS, sharedWords, similarity, stripLinks } from "@/lib/swarm/novelty";
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

/**
 * Hosts X refuses to accept in a post body. `POST /2/tweets` answers 400
 * "The Tweet contains an invalid URL" for every URL on these, so a draft
 * carrying one burns a rail attempt and 15 minutes of backoff for a reason
 * the log does not explain.
 *
 * laura.stonkbrokers.io was verified blocked on 2026-09-16 (probed against
 * /mcp, /lab and the bare host; it had posted successfully on 2026-09-14, so
 * the block is new). stonkbrokers.io, stonkbrokers.wtf, www.stonkbrokers.cash,
 * brokertools.info and github.com all pass. Re-probe and remove the entry once
 * the operator gets the subdomain unblocked.
 */
export const X_BLOCKED_HOSTS: { host: string; since: string; use: string }[] = [
  {
    host: "laura.stonkbrokers.io",
    since: "2026-09-16",
    use: "the GitHub repo (github.com/simplefarmer69/laura-dashboard) or an ecosystem domain such as stonkbrokers.io",
  },
];

/** Blocked hosts present in `text`, whatever the scheme (X auto-links bare hosts too). */
export function blockedHostsIn(text: string): typeof X_BLOCKED_HOSTS {
  const lower = text.toLowerCase();
  return X_BLOCKED_HOSTS.filter((b) => lower.includes(b.host));
}

/** Words that make a closing sentence a citation rather than a verdict. */
const SOURCED_CLOSER = /\b(?:utc|dexscreener|defillama|blockscout|brokertools|docs?|per|source|sep|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/**
 * The account's closing tell (operator, 2026-09-16: "there is a similar
 * pattern every time"). Twelve of the first thirty-seven posts ended on a
 * short verdict bolted after the facts — "fees trail swaps", "depth first,
 * volume second", "the holder line does not care what the candle did" —
 * which reads as one machine with one trick.
 *
 * A closing sentence is treated as an aphorism when it is short AND cites
 * nothing: no figure, no date, no source, no link. A genuine closing fact
 * ("the other six days averaged about $8k.") carries one of those, so this
 * catches the habit without touching posts that end on evidence. The shape
 * list catches the stylised ones that do smuggle in a numeral, such as
 * "one ticker, 20 pools, no bell".
 */
const APHORISM_SHAPES: RegExp[] = [
  /^\s*\w[\w'-]*\s+first,\s/i,
  /\bis\s+the\s+test\b/i,
  /\b(?:a|the)\s+\w+,\s+not\s+(?:a|the)\s+\w+\.?$/i,
  /^(?:[\w$%.,'-]+\s+){1,5}(?:no|never)\s+[\w$%'-]+\.?$/i,
];

const CLOSER_MAX_WORDS = 12;

/** The post's last sentence, links stripped, or "" when there is nothing to read. */
export function finalSentence(text: string): string {
  const withoutLinks = text.replace(/https?:\/\/\S+/g, " ").trim();
  const parts = withoutLinks
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.at(-1) ?? "";
}

/** True when the post ends on a bare verdict instead of its last fact. */
export function closesWithAphorism(text: string): boolean {
  /* A post whose last words are a link ends on the link, not on a verdict:
     the sentence before it is the label for where the reader is being sent,
     and the tail-boilerplate rules already govern that. */
  if (/(?:https?:\/\/\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?)[.\s]*$/i.test(text.trim())) return false;
  const last = finalSentence(text);
  if (!last) return false;
  const words = last.split(/\s+/).filter(Boolean).length;
  if (words < 2) return false;
  if (APHORISM_SHAPES.some((re) => re.test(last))) return true;
  if (words > CLOSER_MAX_WORDS) return false;
  return !/\d/.test(last) && !SOURCED_CLOSER.test(last);
}

export const X_STYLE_GUIDE = [
  `WRITING FOR X (house style, distilled from @aixbt_agent, @vladtenev, @JohannKerbrat, @elonmusk and @OxSimpleFarmer):`,
  `- ONE post, ONE idea, at most ${TWEET_MAX} characters. Never a thread, never "1/", never "🧵", never "(cont.)". If the idea needs more room it is two ideas; keep the sharper one.`,
  `- Never open with a label. No "Official StonkBrokers content", no "LAURA here", no "As an AI agent", no "Update:", no "Thread:", no date stamp, no title. The first words are already the point.`,
  `- Never close with a label. No "Docs:", no "Not financial advice", no "not open to US persons", no "fee-funded, not a dividend" tacked on. No disclaimers, no risk boilerplate, no disclosures about what LAURA is. The post ends when the thought ends.`,
  `- NEVER CLOSE WITH AN APHORISM (operator, 2026-09-16: "there is a similar pattern every time"). The account's tell is a short verdict sentence bolted onto the end that carries no new fact: "the holder line does not care what the candle did", "depth first, volume second", "fees trail swaps", "fees here do not track swap volume", "a token in a pool has no hand to raise", "monday's open is the test", "the weekend has one ticker", "one ticker, 20 pools, no bell", "the token a launch is priced in picks its first buyers", "lending first, until a dex passes steakhouse". Twelve of the last thirty-seven posts ended this way; read together they sound like one machine with one trick. The shapes to avoid: "A first, B second"; "X does not / do not / has no Y"; "X is the test"; "a flag, not a verdict"; a bare three-word summary fragment. STOP AT THE LAST FACT. If the closing sentence contains no number, no date and no source, delete it: the facts already made the point, and trusting the reader to see it is what a person sounds like.`,
  `- Sound like a person who knows the chain. aixbt's template: lead with the thesis as a plain conditional ("if X, Y", "unless X, Y", "as long as X, Y"), then two or three concrete facts with numbers and dates, lowercase, periods, no adjectives. Vlad's template: one confident declarative sentence, a milestone number, sometimes a question. Johann's: a milestone and what it proves ("190+ Stock Tokens, $3B in cumulative volume, and a lot more to build."). Musk's: a short reaction to something real. Simple Farmer's: founder voice, names the product and the pair, invites people to try it.`,
  `- Rotate between those templates and between capitalisation styles across posts. Two consecutive posts must not share an opening word, a sentence shape, a closing phrase or a statistic.`,
  `- No hashtags. No emoji except at most one when it carries the tone. No exclamation marks in a row. No "excited to", "thrilled", "game-changer", "revolutionary", "dive in", "unlock", "leverage", "seamless", "robust". No em dashes. No rhetorical "Here's why" or "Let that sink in" unless quoting.`,
  `- Numbers are the humanity: a real figure from this cycle's data, with its date or window, beats any adjective. Never invent one; never round a figure you were given to a prettier one.`,
  `- Topics people follow this account for: what is actually happening on Robinhood Chain right now (stock tokens, launches, liquidity moves, Vlad and Johann's latest, builders shipping), what LAURA's own wallet did onchain, and the sharpest line from the Cafe Bar debate (quote the agent by name when it is good). Not another explainer of a mechanic the account already explained.`,
  `- ROTATE THE BEAT, AND COVER THE ECOSYSTEM (operator audit 2026-09-18: "repetitive and less insightful for the entire Robinhood eco"). Of the last twenty-four posts, seven were the same reply-launch template and five were DeFiLlama chain aggregates: half the account was two formats. Across all fifty-nine posts, the Special Projects roster (DERP, TickerYard $YARD, Card Wall $WALL, Chain Mancers $MANCER, Oakmont Vault $STRIKE, up. $UP) appeared ZERO times, the Opening Bell and Buyback Bar ZERO, the Anvil NFT AMM once, Smart LP vaults once, the Stonk Exchange and $UP once, the Safety Deposit Box twice, the broker NFTs and Clock In three times. The account is talking about itself and about DeFiLlama top-lines while the ecosystem it exists to grow goes unmentioned. Two rules follow. (1) NEVER run the same beat twice in a row, and never three times in a rolling ten posts: "DeFiLlama says the chain did $Xb of volume, up Y%" is ONE beat no matter which metric is swapped in, and so is "my wallet / my launch earned X". (2) Each post should pick a beat the last few did not use, and the underfed ones are: a Special Project's token or launch, the broker NFT market and the Anvil AMM against OpenSea, a Clock In round and who cranked it, Smart LP vault behaviour, what the Safety Deposit Box actually locked this week, an Opening Bell buyback draw, Nightshades, another builder's launch that is working (not only the ones rugging), and a partner protocol shipping something. The MCP server reads every one of these, so there is no excuse of missing data: a concrete fact about somebody else's corner of the ecosystem is worth more to this account than the fifth chain aggregate.`,
  `- Honesty rules still apply: no price predictions, no calls to buy, no return promises, traceable claims only. Speak as LAURA in the first person when the post is about her own moves; never explain or disclose what she is.`,
  `- Comparative beats absolute. A rank, a share, a gap to the next name, a change against last week: "Robinhood Chain did 20% of all crypto DEX volume yesterday" is read; "$1.5b of volume" is scrolled past. DeFiLlama numbers for the chain and for all of crypto are in the briefing; use them.`,
  `- One cashtag at most. X rejects posts with two or more $SYMBOL tags (API 403, 2026-09-13); name every other token plainly (LOANWORD, not $LOANWORD). The sanitizer demotes extras, but write it right the first time.`,
  `- Written for a stranger, not for the pipeline. The reader never sees the briefing or the rationale: name the product, the chain or the token before the first number; give every number a unit and a referent a person uses; never use pipeline vocabulary ("experiment 56", "proxy", "lever", "lane", "third call", "sale clock", "resubmitted", "this cycle"); never a bare counter ("1089 to 1113"). One takeaway a human can repeat.`,
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
  /* A spaced hyphen is an em dash in disguise ("the pot grew - fees did it").
     Word-internal hyphens (stock-token) and negative numbers are untouched. */
  if (/\S\s+-\s+\S/.test(text)) {
    stripped.push("spaced hyphen used as a dash");
    text = text.replace(/(\S)\s+-\s+(?=[^\d\s])/g, "$1, ");
  }
  /* X refuses posts with more than one cashtag (API 403, seen 2026-09-13 on a
     two-token post). The first keeps its $; the rest become plain symbols,
     which changes no fact. */
  const cashtags = [...text.matchAll(/\$([A-Za-z][A-Za-z0-9_]{0,15})\b/g)];
  if (cashtags.length > 1) {
    let seen = 0;
    text = text.replace(/\$([A-Za-z][A-Za-z0-9_]{0,15})\b/g, (m, sym: string) => (seen++ === 0 ? m : sym));
    stripped.push(`${cashtags.length - 1} extra cashtag(s) demoted to plain symbols (X allows one)`);
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
export function xPostProblems(text: string, recent: XPostLogEntry[], opts: { skipRepeatChecks?: boolean } = {}): string[] {
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
  for (const b of blockedHostsIn(trimmed)) {
    problems.push(`X refuses every URL on ${b.host} with "invalid URL" (since ${b.since}); link ${b.use} instead`);
  }
  if (closesWithAphorism(trimmed)) {
    problems.push(
      `closes on an aphorism ("${finalSentence(trimmed).slice(0, 60)}") instead of its last fact; this account's most repeated habit, delete the closing sentence`,
    );
  }
  if (/\b(?:game[- ]changer|revolutionary|thrilled|excited to|dive in|unlock(?:s|ing)?|leverag(?:e|ing)|seamless|robust)\b/i.test(trimmed)) {
    problems.push("marketing filler word");
  }
  /* A usage reply under our own announcement legitimately shares words with
     it and with earlier contract posts; only the format rules apply. */
  const window = opts.skipRepeatChecks ? [] : recent.slice(0, 12);
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
    const s = similarity(stripLinks(trimmed), stripLinks(e.text));
    if (s >= REPEAT_THRESHOLD && sharedWords(stripLinks(trimmed), stripLinks(e.text)) >= REPEAT_MIN_SHARED_WORDS) {
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
      Headroom: the Auditor's strategy mandates a verbose veto shape (2026-09-12 probe hit
      600; a 2026-09-13 veto ran past 1400 and failed validation, which read as "auditor
      offline" and held a clean post). The prompt asks for 900; the schema tolerates far
      more so a long reason is stored truncated instead of failing the whole read. */
  reason: z.string().max(6000).transform((r) => (r.length > 1400 ? `${r.slice(0, 1397)}...` : r)),
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
    `VETO when any of these hold: a stranger cannot tell after the first sentence what the post is about, or a number in it has no unit or referent a human uses, or it carries pipeline vocabulary (experiment numbers, "proxy", "lever", "lane", "third call", "sale clock", "resubmitted") that only the briefing explains (the 2026-09-13 00:05 UTC post failed every one of these and shipped: never again); it reads like a template or a press release; it opens or closes with a label, a disclaimer or a sign-off; IT CLOSES ON AN APHORISM — a short verdict after the facts that carries no number, date or source ("fees trail swaps", "depth first, volume second", "monday's open is the test", "the weekend has one ticker", "a token in a pool has no hand to raise"), which the operator flagged on 2026-09-16 as the account's most repeated tell: the fix is always to delete that last sentence, so return it as an edit rather than a veto when the rest of the post is good; it is a thread or a numbered fragment; it repeats an opening, a closing, a phrase, a statistic or a theme from the posts below; IT REPEATS A BEAT — the same KIND of post as either of the two most recent, where "DeFiLlama chain aggregates", "my own wallet or my own launch's fees", "$STONKBROKER pair depth and holder counts", "a boosted token is rugging" and "I launched a token answering this post" are each one beat however the numbers change (operator audit 2026-09-18 found half the account running on two of them); veto the third in a row and say which beat is being repeated, because the underfed beats are the whole rest of the ecosystem: Special Projects, the broker NFT market and the Anvil AMM, Clock In rounds, Smart LP vaults, the Safety Deposit Box, the Opening Bell buyback draws, Nightshades, and other builders' launches that are working; it explains a mechanic in the abstract instead of saying what happened; it contains a claim with no number, date, source or event behind it; it predicts price, tells people to buy, or promises a return; it uses filler words, hashtags or stacked punctuation; a human reading it would not say "someone wrote this".`,
    /^smith$|\(smith\)$/.test(input.author.trim())
      ? `THIS IS A CONTRACT ANNOUNCEMENT from Anvil (smith): a newly verified contract with its address in the link. Earlier posts announcing OTHER contracts share its theme by design (the swarm ships contracts; each gets one announcement) and are not duplicates of it. A contract that builds on an earlier announced one (a registry over a market, a frontend over both) has to name the product it extends; that is not a second announcement of the earlier contract, and "the same product" is not a reason to veto. Veto for duplication only when the candidate reuses an earlier post's opening, clause or sentence shape, or carries no fact the earlier post did not (no new function, capability, address or place to use it). Pass when it says in its own words what THIS contract adds and how a person uses it. The links are required and count for nothing.`
      : "",
    `Keep "reason" under 900 characters: name the defect(s) in one or two sentences each; the edit itself belongs in "edited", not in the reason.`,
    `PASS when a human who follows Robinhood Chain would read it, learn one concrete thing, and not notice it was written by an agent. When a light edit (cut words, fix case, drop a label, tighten a clause) turns a near-miss into a pass, return the edit in "edited"; never add a fact, a number, a link or a claim that is not already in the post, and never exceed ${TWEET_MAX} characters.`,
    `ALREADY POSTED FROM THIS ACCOUNT (newest first; the candidate must not echo any of these)\n${recent || "Nothing posted yet."}`,
    `PRODUCER'S RATIONALE (context only, do not judge the rationale)\n${input.rationale.slice(0, 600)}`,
    `CANDIDATE POST (${input.post.length} chars)\n${input.post}`,
  ]
    .filter(Boolean)
    .join("\n\n");
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
