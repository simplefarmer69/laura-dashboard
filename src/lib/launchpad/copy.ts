/**
 * Launch copy hygiene. Mint had learned a sign-off formula from her own
 * earlier launches ("I am LAURA, an AI; popcorn is a snack, not a promise.")
 * and the "what LAURA has already said" digest kept feeding it back to her.
 * AI disclosures and standing disclaimers were retired by operator directive
 * on 2026-09-12, so the sentence is stripped in code from every launch text
 * on intake, on load and in the prompt digest. Pure string work, no imports.
 */

const AI_SIGNOFF_RE = /\s*[“"']?\bI am LAURA,? an AI\b[^.!?\n]*[.!?]?[”"']?/gi;
const NOT_A_PROMISE_TAIL_RE = /\s*[“"']?[^.!?\n]*\bnot a promise\b[^.!?\n]*[.!?]?[”"']?\s*$/i;
const CLOSING_DISCLAIMER_RE = /\s*\(?\b(?:not financial advice|nfa|this is not investment advice)\b[^.!?\n]*[.!?)]?\s*$/i;

export function stripLaunchSignoff(text: string): string {
  let out = text.replace(AI_SIGNOFF_RE, "");
  out = out.replace(NOT_A_PROMISE_TAIL_RE, "");
  out = out.replace(CLOSING_DISCLAIMER_RE, "");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** Returns a copy of any launch-like record with its text fields cleaned; the same object when nothing changed. */
export function stripLaunchSignoffs<T extends { concept: string; message?: string | null; rationale?: string }>(l: T): T {
  const concept = stripLaunchSignoff(l.concept) || l.concept;
  const message = l.message == null ? l.message : stripLaunchSignoff(l.message) || null;
  const rationale = l.rationale == null ? l.rationale : stripLaunchSignoff(l.rationale);
  if (concept === l.concept && message === l.message && rationale === l.rationale) return l;
  return { ...l, concept, message, rationale };
}
