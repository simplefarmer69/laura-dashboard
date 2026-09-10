import type { Draft } from "@/lib/types";

/**
 * Cheap write-time novelty gate. Repetition is a write-time problem: retrieval
 * can't fix output that never got compared against history before landing.
 * Normalized token overlap is deliberately simple — no LLM call, deterministic,
 * and good enough to catch the near-duplicates agents actually produce
 * (same angle re-derived from the same inputs). Thematic, judgment-level
 * repetition is the critic agent's job, not this gate's.
 */

const WORD_RE = /[a-z0-9$][a-z0-9$']*/g;

/** Words that carry no angle: metrics boilerplate would otherwise dominate overlap. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "has", "have",
  "you", "your", "our", "its", "than", "then", "into", "over", "under", "about",
  "what", "when", "where", "how", "why", "who", "not", "but", "per", "via", "vs",
]);

export function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    const w = m[0];
    if (w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}

/** Overlap coefficient: |A ∩ B| / min(|A|, |B|). Robust to length differences. */
export function similarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let inter = 0;
  for (const w of small) if (large.has(w)) inter += 1;
  return inter / small.size;
}

/** Above this, a draft is a near-duplicate and is rejected at write time. */
export const NOVELTY_THRESHOLD = 0.72;

/** How many of the agent's recent drafts each new draft is compared against. */
export const NOVELTY_WINDOW = 12;

export interface NoveltyVerdict {
  ok: boolean;
  /** Highest similarity found and the draft that produced it. */
  score: number;
  nearest: Draft | null;
}

/**
 * Checks a candidate draft against the agent's recent output. Recurring
 * report formats (the daily metrics report) are template-similar by design,
 * so kind "report" is exempt from the hard gate — the critic still reviews it.
 */
export function checkNovelty(
  candidate: { agentId: string; kind: string; title: string; body: string },
  drafts: Draft[],
): NoveltyVerdict {
  if (candidate.kind === "report") return { ok: true, score: 0, nearest: null };
  const recent = drafts.filter((d) => d.agentId === candidate.agentId).slice(-NOVELTY_WINDOW);
  const text = `${candidate.title}\n${candidate.body}`;
  let score = 0;
  let nearest: Draft | null = null;
  for (const d of recent) {
    const s = similarity(text, `${d.title}\n${d.body}`);
    if (s > score) {
      score = s;
      nearest = d;
    }
  }
  return { ok: score < NOVELTY_THRESHOLD, score, nearest };
}
