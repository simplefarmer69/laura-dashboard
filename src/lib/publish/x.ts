import { createHmac, randomBytes } from "node:crypto";
import { checkXGuards, recordXPost, type XGuardVerdict } from "@/lib/publish/x-guard";

/**
 * X (Twitter) publishing rail. Two user-context auth paths, no SDK needed:
 *  - OAuth 1.0a (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET),
 *    signed locally with node:crypto; preferred when the full set is present.
 *  - OAuth 2.0 user token (X_OAUTH2_ACCESS_TOKEN with the tweet.write scope),
 *    sent as a plain Bearer header — the path the operator provisioned
 *    2026-09-12.
 * X_BEARER_TOKEN alone is app-only and read-only; it can never post.
 *
 * Two callers: the operator's "Publish to X" button and the autonomous rail
 * in publish/auto.ts; both pass the shared-account guards in x-guard.ts
 * before anything is sent.
 */

const TWEET_MAX = 280;

export interface XStatus {
  appKeys: boolean;
  accessKeys: boolean;
  /** OAuth 2.0 user token (tweet.write) present — posts as a Bearer header. */
  oauth2: boolean;
  ready: boolean;
  missing: string[];
}

export function xStatus(): XStatus {
  const missing: string[] = [];
  for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) {
    if (!process.env[k]) missing.push(k);
  }
  const appKeys = Boolean(process.env.X_API_KEY && process.env.X_API_SECRET);
  const accessKeys = Boolean(process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET);
  const oauth2 = Boolean(process.env.X_OAUTH2_ACCESS_TOKEN);
  return { appKeys, accessKeys, oauth2, ready: (appKeys && accessKeys) || oauth2, missing };
}

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthHeader(method: "POST", url: string): string {
  const params: Record<string, string> = {
    oauth_consumer_key: process.env.X_API_KEY ?? "",
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: process.env.X_ACCESS_TOKEN ?? "",
    oauth_version: "1.0",
  };
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const base = `${method}&${pct(url)}&${pct(paramString)}`;
  const signingKey = `${pct(process.env.X_API_SECRET ?? "")}&${pct(process.env.X_ACCESS_TOKEN_SECRET ?? "")}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");
  const all = { ...params, oauth_signature: signature };
  return `OAuth ${Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}="${pct(all[k as keyof typeof all])}"`)
    .join(", ")}`;
}

/** OAuth 1.0a when the full key set exists, else the OAuth 2.0 user token. */
function authHeader(method: "POST", url: string): string {
  const s = xStatus();
  if (s.appKeys && s.accessKeys) return oauthHeader(method, url);
  return `Bearer ${process.env.X_OAUTH2_ACCESS_TOKEN ?? ""}`;
}

async function postTweet(text: string, replyToId?: string): Promise<{ id: string }> {
  const url = "https://api.x.com/2/tweets";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: authHeader("POST", url),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text,
      ...(replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { data?: { id: string }; title?: string; detail?: string; errors?: unknown };
  if (!res.ok || !json.data) {
    throw new Error(`X API ${res.status}: ${json.detail ?? json.title ?? JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

/**
 * Posts one reply under someone else's tweet. Used by the mentions rail,
 * which keeps its own log and caps: a reply is a conversation turn, not a
 * timeline post, so it neither consumes nor bypasses the original-post caps.
 * The caller is responsible for the self-interaction check (never reply to
 * the account's own tweets) and for the content gates.
 */
export async function replyOnX(text: string, toTweetId: string): Promise<{ id: string; url: string }> {
  const status = xStatus();
  if (!status.ready) throw new Error(`X posting not configured. Missing: ${status.missing.join(", ")}`);
  const t = text.trim();
  if (t.length === 0 || t.length > TWEET_MAX) throw new Error(`Reply must be 1-${TWEET_MAX} chars (got ${t.length})`);
  const posted = await postTweet(t, toTweetId);
  return { id: posted.id, url: `https://x.com/i/web/status/${posted.id}` };
}

/**
 * Splits a draft body into tweet-sized chunks. Thread drafts are written as
 * blank-line-separated posts; anything longer than 280 chars is hard-split on
 * sentence boundaries as a fallback.
 */
export function splitForThread(body: string, isThread: boolean): string[] {
  const paragraphs = isThread
    ? body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    : [body.trim()];
  const tweets: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= TWEET_MAX) {
      tweets.push(p);
      continue;
    }
    let rest = p;
    while (rest.length > TWEET_MAX) {
      let cut = rest.lastIndexOf(". ", TWEET_MAX - 2);
      if (cut < TWEET_MAX * 0.4) cut = rest.lastIndexOf(" ", TWEET_MAX - 2);
      if (cut <= 0) cut = TWEET_MAX - 1;
      tweets.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) tweets.push(rest);
  }
  return tweets.slice(0, 25);
}

export interface PublishResult {
  url: string;
  tweetIds: string[];
}

export interface DryRunResult {
  /** Whether a real publish would go through right now (creds + guards). */
  wouldPost: boolean;
  status: XStatus;
  guard: XGuardVerdict;
  /** The exact tweet texts a real publish would send, in order. */
  tweets: string[];
}

/**
 * Everything publishToX does except the network call: creds check, shared
 * account guard verdict and the exact split. Never posts, never mutates the
 * post log. Use this to smoke-test the pipeline before the first live post.
 */
export async function dryRunToX(body: string, isThread: boolean): Promise<DryRunResult> {
  const status = xStatus();
  const guard = await checkXGuards(body);
  const tweets = splitForThread(body, isThread);
  return { wouldPost: status.ready && guard.ok && tweets.length > 0, status, guard, tweets };
}

/**
 * Posts a draft as a tweet or reply-chained thread. Throws if creds are
 * missing or the shared-account guards (rate caps, duplicate memory,
 * self-interaction) refuse the post. Successful posts land in the local post
 * log so the guards see them.
 */
export async function publishToX(body: string, isThread: boolean): Promise<PublishResult> {
  const status = xStatus();
  if (!status.ready) {
    throw new Error(
      `X posting not configured. Missing: ${status.missing.join(", ")} (or set X_OAUTH2_ACCESS_TOKEN with the tweet.write scope). The bearer token alone is read-only.`,
    );
  }
  const guard = await checkXGuards(body);
  if (!guard.ok) {
    throw new Error(`X guard refused the post: ${guard.reasons.join("; ")}`);
  }
  const tweets = splitForThread(body, isThread);
  if (tweets.length === 0) throw new Error("Nothing to post: draft body is empty");
  const ids: string[] = [];
  for (const t of tweets) {
    const prev = ids.at(-1);
    const posted = await postTweet(t, prev);
    ids.push(posted.id);
    if (tweets.length > 1) await new Promise((r) => setTimeout(r, 1_200));
  }
  const url = `https://x.com/i/web/status/${ids[0]}`;
  await recordXPost({ url, firstTweetId: ids[0], text: body });
  return { url, tweetIds: ids };
}
