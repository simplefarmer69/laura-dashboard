import { htmlToText, hostAllowed, searchWeb } from "@/lib/swarm/browser";

/**
 * Reddit for the swarm.
 *
 * Reddit refuses anonymous reads from datacenter addresses (HTTP 403 on both
 * www and old, JSON included; confirmed from this host 2026-10-01), so every
 * read goes through the official OAuth API with a script app:
 *   REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET          → app-only token, read
 *   + REDDIT_USERNAME + REDDIT_PASSWORD              → user token, read and write
 * Without the app, reading degrades to search-engine hits (titles and links
 * only) so the swarm still learns which threads exist.
 *
 * Writes are a separate hat from reads and live behind their own caps in
 * outreach.ts; this module only knows how to perform them.
 */

export type RedditAccess = "none" | "read" | "write";

export interface RedditPost {
  id: string;
  fullname: string;
  subreddit: string;
  title: string;
  /** Self text, trimmed. Empty for link posts. */
  text: string;
  author: string;
  score: number;
  numComments: number;
  /** reddit.com permalink (no host). */
  permalink: string;
  /** Outbound link for link posts; the permalink otherwise. */
  url: string;
  createdUtc: number;
}

export interface RedditComment {
  id: string;
  fullname: string;
  author: string;
  score: number;
  text: string;
  createdUtc: number;
}

export interface RedditThread {
  post: RedditPost;
  comments: RedditComment[];
}

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";
const TIMEOUT_MS = 20_000;
const MAX_TEXT = 700;
const MAX_COMMENT = 420;

function userAgent(): string {
  return process.env.REDDIT_USER_AGENT?.trim() || "web:laura-swarm:1.0 (by /u/LAURA_DAIO)";
}

export function redditAccess(): RedditAccess {
  const id = process.env.REDDIT_CLIENT_ID?.trim();
  const secret = process.env.REDDIT_CLIENT_SECRET?.trim();
  if (!id || !secret) return "none";
  const user = process.env.REDDIT_USERNAME?.trim();
  const pass = process.env.REDDIT_PASSWORD?.trim();
  return user && pass ? "write" : "read";
}

declare global {
  var __lauraRedditToken: { token: string; expiresAt: number; access: RedditAccess } | undefined;
}

async function token(): Promise<string> {
  const access = redditAccess();
  if (access === "none") throw new Error("reddit: no app credentials (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET)");
  const cached = globalThis.__lauraRedditToken;
  if (cached && cached.access === access && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams(
    access === "write"
      ? { grant_type: "password", username: process.env.REDDIT_USERNAME!.trim(), password: process.env.REDDIT_PASSWORD!.trim() }
      : { grant_type: "client_credentials" },
  );
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID!.trim()}:${process.env.REDDIT_CLIENT_SECRET!.trim()}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`reddit token HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!json.access_token) throw new Error(`reddit token refused: ${json.error ?? "no token"}`);
  globalThis.__lauraRedditToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000, access };
  return json.access_token;
}

async function api<T>(path: string, init?: { method?: "GET" | "POST"; form?: Record<string, string> }): Promise<T> {
  const t = await token();
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${t}`,
      "user-agent": userAgent(),
      ...(init?.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.form ? new URLSearchParams(init.form) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) throw new Error("reddit: rate limited (429)");
  if (!res.ok) throw new Error(`reddit HTTP ${res.status} on ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

interface Listing<T> {
  data?: { children?: { kind: string; data: T }[] };
}

interface RawPost {
  id: string;
  name: string;
  subreddit: string;
  title: string;
  selftext?: string;
  author: string;
  score?: number;
  num_comments?: number;
  permalink: string;
  url?: string;
  created_utc?: number;
  over_18?: boolean;
}

interface RawComment {
  id: string;
  name: string;
  author?: string;
  score?: number;
  body?: string;
  created_utc?: number;
  stickied?: boolean;
}

function clean(s: string | undefined, max: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function toPost(r: RawPost): RedditPost {
  return {
    id: r.id,
    fullname: r.name,
    subreddit: r.subreddit,
    title: clean(r.title, 200),
    text: clean(r.selftext, MAX_TEXT),
    author: r.author,
    score: r.score ?? 0,
    numComments: r.num_comments ?? 0,
    permalink: r.permalink,
    url: r.url && /^https?:\/\//.test(r.url) ? r.url : `https://www.reddit.com${r.permalink}`,
    createdUtc: r.created_utc ?? 0,
  };
}

/** Searches Reddit (one subreddit or all); newest first by default. Adult content is dropped. */
export async function redditSearch(
  query: string,
  opts: { subreddit?: string; sort?: "new" | "relevance" | "top" | "comments"; time?: "day" | "week" | "month" | "year" | "all"; limit?: number } = {},
): Promise<RedditPost[]> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
  const q = new URLSearchParams({ q: query.slice(0, 200), sort: opts.sort ?? "new", t: opts.time ?? "month", limit: String(limit), type: "link" });
  let path = `/search?${q}`;
  if (opts.subreddit) {
    q.set("restrict_sr", "1");
    path = `/r/${encodeURIComponent(opts.subreddit.replace(/^r\//, ""))}/search?${q}`;
  }
  const out = await api<Listing<RawPost>>(path);
  return (out.data?.children ?? []).map((c) => c.data).filter((p) => !p.over_18).map(toPost);
}

/** Newest posts in a subreddit. */
export async function redditNew(subreddit: string, limit = 10): Promise<RedditPost[]> {
  const out = await api<Listing<RawPost>>(`/r/${encodeURIComponent(subreddit.replace(/^r\//, ""))}/new?limit=${Math.min(limit, 25)}`);
  return (out.data?.children ?? []).map((c) => c.data).filter((p) => !p.over_18).map(toPost);
}

/** A thread: the post and its top comments (best sort). Accepts a permalink or a full reddit URL. */
export async function redditThread(permalinkOrUrl: string, commentLimit = 12): Promise<RedditThread> {
  const permalink = permalinkOrUrl.replace(/^https?:\/\/(www\.|old\.)?reddit\.com/i, "").replace(/\/?$/, "/");
  if (!/^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(permalink)) throw new Error("reddit: not a thread permalink");
  const out = await api<[Listing<RawPost>, Listing<RawComment>]>(`${permalink}.json?limit=${Math.min(commentLimit, 40)}&depth=1&sort=confidence`);
  const raw = out[0]?.data?.children?.[0]?.data;
  if (!raw) throw new Error("reddit: thread not found");
  const comments = (out[1]?.data?.children ?? [])
    .filter((c) => c.kind === "t1" && c.data.body && !c.data.stickied && c.data.author !== "AutoModerator")
    .slice(0, commentLimit)
    .map((c) => ({
      id: c.data.id,
      fullname: c.data.name,
      author: c.data.author ?? "[deleted]",
      score: c.data.score ?? 0,
      text: clean(c.data.body, MAX_COMMENT),
      createdUtc: c.data.created_utc ?? 0,
    }));
  return { post: toPost(raw), comments };
}

/**
 * Keyless fallback: what a search engine knows about Reddit threads on the
 * topic. Titles and links only; the pages themselves are not readable from
 * here without the app.
 */
export async function redditSearchViaWeb(query: string, limit = 6): Promise<{ title: string; url: string }[]> {
  const hits = await searchWeb(`site:reddit.com ${query}`, limit);
  return hits.filter((h) => /reddit\.com\/r\//i.test(h.url) && hostAllowed(h.url)).map((h) => ({ title: h.title, url: h.url }));
}

/* --------------------------------- writes --------------------------------- */

export interface RedditWriteResult {
  url: string;
  fullname: string;
}

interface SubmitResponse {
  json?: { errors?: unknown[][]; data?: { things?: { data?: { name?: string; permalink?: string; id?: string; link_id?: string } }[]; url?: string; name?: string; id?: string } };
}

function firstError(res: SubmitResponse): string | null {
  const e = res.json?.errors?.[0];
  return e ? e.map(String).join(" ") : null;
}

/** Replies to a post or comment by fullname (t3_… or t1_…). Needs the user grant. */
export async function redditComment(parentFullname: string, text: string): Promise<RedditWriteResult> {
  if (redditAccess() !== "write") throw new Error("reddit: no user credentials (REDDIT_USERNAME, REDDIT_PASSWORD)");
  if (!/^t[13]_[a-z0-9]+$/i.test(parentFullname)) throw new Error("reddit: bad parent fullname");
  const res = await api<SubmitResponse>("/api/comment", { method: "POST", form: { api_type: "json", thing_id: parentFullname, text } });
  const err = firstError(res);
  if (err) throw new Error(`reddit refused the comment: ${err}`);
  const thing = res.json?.data?.things?.[0]?.data;
  const permalink = thing?.permalink;
  return { url: permalink ? `https://www.reddit.com${permalink}` : "", fullname: thing?.name ?? "" };
}

/** A new self post in a subreddit. Needs the user grant. */
export async function redditSubmit(subreddit: string, title: string, text: string): Promise<RedditWriteResult> {
  if (redditAccess() !== "write") throw new Error("reddit: no user credentials (REDDIT_USERNAME, REDDIT_PASSWORD)");
  const res = await api<SubmitResponse>("/api/submit", {
    method: "POST",
    form: { api_type: "json", kind: "self", sr: subreddit.replace(/^r\//, ""), title: title.slice(0, 300), text, sendreplies: "true" },
  });
  const err = firstError(res);
  if (err) throw new Error(`reddit refused the post: ${err}`);
  return { url: res.json?.data?.url ?? "", fullname: res.json?.data?.name ?? "" };
}

/** Prompt block for a thread. The text is other people's words and is marked as such by the caller. */
export function redditThreadText(t: RedditThread): string {
  const head = `r/${t.post.subreddit} · "${t.post.title}" by u/${t.post.author} · ${t.post.score} points · ${t.post.numComments} comments · https://www.reddit.com${t.post.permalink}`;
  const body = t.post.text ? `\n${t.post.text}` : "";
  const comments = t.comments.map((c) => `  [${c.fullname}] u/${c.author} (${c.score}): ${c.text}`).join("\n");
  return `${head}${body}${comments ? `\nTOP COMMENTS\n${comments}` : "\n(no comments yet)"}`;
}

/** Prompt block for search results. */
export function redditPostsText(posts: RedditPost[]): string {
  if (posts.length === 0) return "(no matching posts)";
  return posts
    .map((p) => {
      const age = p.createdUtc ? `${Math.max(0, Math.round((Date.now() / 1000 - p.createdUtc) / 3600))}h ago` : "";
      return `- [${p.fullname}] r/${p.subreddit} · "${p.title}" · ${p.score} pts, ${p.numComments} comments ${age} · https://www.reddit.com${p.permalink}${p.text ? `\n  ${p.text.slice(0, 240)}` : ""}`;
    })
    .join("\n");
}

/** Unused here but kept for symmetry with the forum reader's HTML bodies. */
export const stripHtml = (html: string): string => htmlToText(html).text;
