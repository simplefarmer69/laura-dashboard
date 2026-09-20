/**
 * Machine checks on delivered work (operator directive 2026-09-20).
 *
 * LAURA may only hire for work she can confirm herself. Not because people
 * lie, but because approving a bounty is releasing money and "it looks fine
 * to me" is not a standard she can hold consistently at three in the morning
 * with no human awake. Every job therefore carries a check that runs against
 * an API, and the check is written into the brief so the worker knows exactly
 * what they are being measured against before they start.
 *
 * A check that cannot run is a failure, never a pass. If X is unreachable or
 * a page times out, the job stays unapproved and gets looked at again next
 * cycle; the escrow is safe either way and the worker keeps their deadline.
 */

export type JobVerification =
  | {
      /** Proof is a post on X. Checked through the v2 API: it exists, it is public, and it says what the brief required. */
      kind: "x-post";
      /** Every one of these must appear in the post text, case insensitive. */
      mustInclude: string[];
      /** Optional: the post must link to this host (matched against the unwound URL). */
      mustLinkHost?: string;
      /** Optional: the post must come from this handle, without the @. */
      mustBeAuthor?: string;
    }
  | {
      /** Proof is a public page. Fetched with no credentials, so "public" is part of the test. */
      kind: "url";
      mustInclude: string[];
      /** Optional host the proof URL must sit on. */
      mustBeHost?: string;
    };

export interface VerificationResult {
  verified: boolean;
  reason: string;
  /** What the check actually saw, so an approval can be audited later. */
  evidence: Record<string, unknown>;
}

const TWEET_ID = /(?:x\.com|twitter\.com)\/[^/]+\/status(?:es)?\/(\d+)/i;

/** Pull the first tweet id out of anything the worker handed back. */
export function tweetIdFrom(proof: { text?: string; links?: string[] }): string | null {
  for (const s of [...(proof.links ?? []), proof.text ?? ""]) {
    const m = TWEET_ID.exec(s ?? "");
    if (m) return m[1];
  }
  const bare = /^\s*(\d{10,25})\s*$/.exec(proof.text ?? "");
  return bare ? bare[1] : null;
}

function firstUrl(proof: { text?: string; links?: string[] }): string | null {
  if (proof.links?.length) return proof.links[0];
  const m = /https?:\/\/\S+/.exec(proof.text ?? "");
  return m ? m[0] : null;
}

function missingTerms(haystack: string, terms: string[]): string[] {
  const h = haystack.toLowerCase();
  return terms.filter((t) => t.trim() && !h.includes(t.trim().toLowerCase()));
}

async function verifyXPost(v: Extract<JobVerification, { kind: "x-post" }>, proof: { text?: string; links?: string[] }): Promise<VerificationResult> {
  const id = tweetIdFrom(proof);
  if (!id) return { verified: false, reason: "no X post link in the submission; the proof must contain a link to the post", evidence: {} };
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) return { verified: false, reason: "cannot check X right now (no bearer token configured), so this stays unapproved", evidence: { tweetId: id } };

  let body: {
    data?: { text?: string; author_id?: string; created_at?: string; public_metrics?: Record<string, number>; entities?: { urls?: { expanded_url?: string; unwound_url?: string }[] } };
    includes?: { users?: { id: string; username: string }[] };
    errors?: { title?: string; detail?: string }[];
  };
  try {
    const url = `https://api.twitter.com/2/tweets/${id}?tweet.fields=created_at,public_metrics,author_id,entities&expansions=author_id&user.fields=username`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000) });
    body = (await res.json()) as typeof body;
    if (!res.ok) return { verified: false, reason: `X refused the lookup (${res.status}), so this stays unapproved`, evidence: { tweetId: id } };
  } catch (err) {
    return { verified: false, reason: `could not reach X to check the post: ${String(err).slice(0, 120)}`, evidence: { tweetId: id } };
  }

  if (!body.data) {
    /* Deleted, private, or never existed. All three mean the same thing here:
       there is nothing public to pay for. */
    return { verified: false, reason: `no public post at that id (${body.errors?.[0]?.detail ?? "not found"}); it may have been deleted or the account is protected`, evidence: { tweetId: id } };
  }

  const text = body.data.text ?? "";
  const author = body.includes?.users?.find((u) => u.id === body.data?.author_id)?.username ?? "";
  const evidence = { tweetId: id, author, createdAt: body.data.created_at, metrics: body.data.public_metrics, text: text.slice(0, 280) };

  if (v.mustBeAuthor && author.toLowerCase() !== v.mustBeAuthor.toLowerCase()) {
    return { verified: false, reason: `the post is by @${author}, but the job required @${v.mustBeAuthor}`, evidence };
  }
  const missing = missingTerms(text, v.mustInclude);
  if (missing.length) return { verified: false, reason: `the post does not mention ${missing.map((m) => `"${m}"`).join(", ")}, which the brief required`, evidence };
  if (v.mustLinkHost) {
    const urls = (body.data.entities?.urls ?? []).map((u) => u.unwound_url ?? u.expanded_url ?? "");
    const hit = urls.some((u) => {
      try {
        return new URL(u).hostname.toLowerCase().endsWith(v.mustLinkHost!.toLowerCase());
      } catch {
        return false;
      }
    });
    if (!hit) return { verified: false, reason: `the post does not link to ${v.mustLinkHost}`, evidence: { ...evidence, urls } };
  }
  return { verified: true, reason: `post by @${author} is public and contains everything the brief asked for`, evidence };
}

async function verifyUrl(v: Extract<JobVerification, { kind: "url" }>, proof: { text?: string; links?: string[] }): Promise<VerificationResult> {
  const url = firstUrl(proof);
  if (!url) return { verified: false, reason: "no link in the submission", evidence: {} };
  if (v.mustBeHost) {
    try {
      if (!new URL(url).hostname.toLowerCase().endsWith(v.mustBeHost.toLowerCase())) {
        return { verified: false, reason: `the link is not on ${v.mustBeHost}`, evidence: { url } };
      }
    } catch {
      return { verified: false, reason: "the submission's link is not a valid URL", evidence: { url } };
    }
  }
  try {
    /* No credentials and no cookies on purpose: the brief promises the work
       is readable by anyone, so the check has to be made as anyone. */
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000), redirect: "follow" });
    if (!res.ok) return { verified: false, reason: `the page did not load for a logged out reader (${res.status})`, evidence: { url } };
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g, " ");
    const missing = missingTerms(text, v.mustInclude);
    if (missing.length) return { verified: false, reason: `the page does not contain ${missing.map((m) => `"${m}"`).join(", ")}, which the brief required`, evidence: { url, bytes: html.length } };
    return { verified: true, reason: `the page is public and contains everything the brief asked for`, evidence: { url, bytes: html.length } };
  } catch (err) {
    return { verified: false, reason: `could not load the page: ${String(err).slice(0, 120)}`, evidence: { url } };
  }
}

export async function verifyJobSubmission(v: JobVerification, proof: { text?: string; links?: string[] } | null | undefined): Promise<VerificationResult> {
  if (!proof) return { verified: false, reason: "nothing has been submitted yet", evidence: {} };
  switch (v.kind) {
    case "x-post":
      return verifyXPost(v, proof);
    case "url":
      return verifyUrl(v, proof);
    default: {
      const _exhaustive: never = v;
      return _exhaustive;
    }
  }
}

/**
 * The check, in the words the worker will read. Every job description has to
 * carry this, otherwise the worker is being marked against a rule they were
 * never shown.
 */
export function describeVerification(v: JobVerification): string {
  switch (v.kind) {
    case "x-post": {
      const bits = [`I check the post through the X API`];
      if (v.mustBeAuthor) bits.push(`it must be posted by @${v.mustBeAuthor}`);
      if (v.mustInclude.length) bits.push(`it must mention ${v.mustInclude.map((t) => `"${t}"`).join(" and ")}`);
      if (v.mustLinkHost) bits.push(`it must link to ${v.mustLinkHost}`);
      return `${bits.join(", ")}, and it must still be public when I look.`;
    }
    case "url": {
      const bits = [`I fetch the link logged out`];
      if (v.mustBeHost) bits.push(`it must be on ${v.mustBeHost}`);
      if (v.mustInclude.length) bits.push(`the page must contain ${v.mustInclude.map((t) => `"${t}"`).join(" and ")}`);
      return `${bits.join(", ")}.`;
    }
    default: {
      const _exhaustive: never = v;
      return _exhaustive;
    }
  }
}
