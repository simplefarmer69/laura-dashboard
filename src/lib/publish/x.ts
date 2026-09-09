import { createHmac, randomBytes } from "node:crypto";

/**
 * X (Twitter) publishing rail. Posting uses OAuth 1.0a user context, signed
 * locally with node:crypto — no SDK needed. Publishing stays human-gated: it
 * only runs when the operator clicks "Publish to X" on an approved draft.
 *
 * Required env for posting: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
 * X_ACCESS_TOKEN_SECRET. X_BEARER_TOKEN alone is read-only.
 */

const TWEET_MAX = 280;

export interface XStatus {
  appKeys: boolean;
  accessKeys: boolean;
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
  return { appKeys, accessKeys, ready: appKeys && accessKeys, missing };
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

async function postTweet(text: string, replyToId?: string): Promise<{ id: string }> {
  const url = "https://api.x.com/2/tweets";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: oauthHeader("POST", url),
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

/** Posts a draft as a tweet or reply-chained thread. Throws if creds missing. */
export async function publishToX(body: string, isThread: boolean): Promise<PublishResult> {
  const status = xStatus();
  if (!status.ready) {
    throw new Error(
      `X posting not configured. Missing: ${status.missing.join(", ")}. The bearer token alone is read-only — add the Access Token and Secret (Read & Write) from the X developer portal.`,
    );
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
  return { url: `https://x.com/i/web/status/${ids[0]}`, tweetIds: ids };
}
