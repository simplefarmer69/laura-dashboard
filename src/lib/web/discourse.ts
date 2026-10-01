import { hostAllowed, htmlToText } from "@/lib/swarm/browser";

/**
 * Discourse forums for the swarm (read only).
 *
 * Most crypto governance and research forums run Discourse, and every
 * Discourse site exposes the same two JSON endpoints without a login:
 * `/search.json?q=` and `/t/<slug>/<id>.json`. Reading them is far cheaper
 * and cleaner than rendering the pages, so the browser worker is only used
 * for forums that are not Discourse. Verified from this host 2026-10-01 on
 * ethresear.ch and forum.arbitrum.foundation.
 *
 * There is no write path here on purpose: forum accounts are per site, need
 * email verification and trust levels, and nothing in the mission needs
 * LAURA to post on someone else's governance forum. She reads, learns, and
 * carries what she learns to X, Reddit and the Pager floor.
 */

export interface ForumSite {
  /** Short label agents use in tool calls ("ethresearch", "arbitrum"). */
  key: string;
  /** Origin, no trailing slash. */
  base: string;
  about: string;
}

export interface ForumHit {
  site: string;
  topicId: number;
  title: string;
  url: string;
  excerpt: string;
  replies: number;
  createdAt: string;
}

export interface ForumPost {
  author: string;
  text: string;
  createdAt: string;
  likes: number;
}

export interface ForumTopic {
  site: string;
  title: string;
  url: string;
  category: string;
  views: number;
  replies: number;
  posts: ForumPost[];
}

const DEFAULT_SITES: ForumSite[] = [
  { key: "ethresearch", base: "https://ethresear.ch", about: "Ethereum research (protocol, rollups, MEV, cryptoeconomics)" },
  { key: "ethmagicians", base: "https://ethereum-magicians.org", about: "Ethereum standards and EIP discussion" },
  { key: "arbitrum", base: "https://forum.arbitrum.foundation", about: "Arbitrum DAO governance (Robinhood Chain is an Arbitrum Orbit chain)" },
  { key: "uniswap", base: "https://gov.uniswap.org", about: "Uniswap governance (the launcher's pools are v3 style)" },
  { key: "aave", base: "https://governance.aave.com", about: "Aave governance and risk" },
  { key: "makerdao", base: "https://forum.makerdao.com", about: "Sky and MakerDAO governance" },
];

const TIMEOUT_MS = 20_000;
const MAX_POST = 600;
const MAX_POSTS = 10;
const UA = "Mozilla/5.0 (X11; Linux x86_64) laura-swarm-browser/1.0 (read-only)";

/** Operator extras through SWARM_FORUMS=key=https://host,key2=https://host2. */
export function forumSites(): ForumSite[] {
  const extra = (process.env.SWARM_FORUMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair): ForumSite | null => {
      const [key, base] = pair.split("=");
      if (!key || !base || !/^https:\/\//.test(base) || !hostAllowed(base)) return null;
      return { key: key.trim().toLowerCase(), base: base.trim().replace(/\/$/, ""), about: "operator added forum" };
    })
    .filter((s): s is ForumSite => s !== null);
  const seen = new Set(DEFAULT_SITES.map((s) => s.key));
  return [...DEFAULT_SITES, ...extra.filter((s) => !seen.has(s.key))];
}

export function forumSitesForPrompt(): string {
  return forumSites()
    .map((s) => `${s.key} (${new URL(s.base).hostname}: ${s.about})`)
    .join("; ");
}

function siteByKeyOrUrl(keyOrUrl: string): ForumSite | null {
  const sites = forumSites();
  const k = keyOrUrl.trim().toLowerCase();
  const byKey = sites.find((s) => s.key === k);
  if (byKey) return byKey;
  try {
    const host = new URL(keyOrUrl).hostname.toLowerCase();
    return sites.find((s) => new URL(s.base).hostname === host) ?? null;
  } catch {
    return null;
  }
}

async function getJson<T>(url: string): Promise<T> {
  if (!hostAllowed(url)) throw new Error("forum: host denied by the open-web policy");
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) throw new Error("forum: rate limited (429)");
  if (!res.ok) throw new Error(`forum HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error("forum: not a Discourse JSON endpoint (bot wall or non Discourse site)");
  return (await res.json()) as T;
}

function clean(html: string | undefined, max: number): string {
  return htmlToText(html ?? "").text.replace(/\s+/g, " ").trim().slice(0, max);
}

interface SearchJson {
  posts?: { id: number; topic_id: number; blurb?: string; created_at?: string; username?: string }[];
  topics?: { id: number; title: string; slug: string; posts_count?: number; created_at?: string }[];
}

/** Searches one forum. `site` is a key from forumSites() or any URL on that forum. */
export async function discourseSearch(site: string, query: string, limit = 8): Promise<ForumHit[]> {
  const s = siteByKeyOrUrl(site);
  if (!s) throw new Error(`forum: unknown site "${site}"; known: ${forumSites().map((x) => x.key).join(", ")}`);
  const json = await getJson<SearchJson>(`${s.base}/search.json?q=${encodeURIComponent(query.slice(0, 160))}`);
  const topics = new Map((json.topics ?? []).map((t) => [t.id, t]));
  const out: ForumHit[] = [];
  const seen = new Set<number>();
  for (const p of json.posts ?? []) {
    const t = topics.get(p.topic_id);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({
      site: s.key,
      topicId: t.id,
      title: t.title,
      url: `${s.base}/t/${t.slug}/${t.id}`,
      excerpt: clean(p.blurb, 240),
      replies: Math.max(0, (t.posts_count ?? 1) - 1),
      createdAt: (t.created_at ?? p.created_at ?? "").slice(0, 10),
    });
    if (out.length >= limit) break;
  }
  return out;
}

interface TopicJson {
  title: string;
  views?: number;
  posts_count?: number;
  category_id?: number;
  post_stream?: { posts?: { username?: string; cooked?: string; created_at?: string; like_count?: number; post_type?: number }[] };
}

/** Reads a topic (opener and the first replies) from its URL on a known forum. */
export async function discourseTopic(url: string, postLimit = MAX_POSTS): Promise<ForumTopic> {
  const s = siteByKeyOrUrl(url);
  if (!s) throw new Error("forum: that URL is not on a known Discourse site");
  const m = /\/t\/(?:[^/]+\/)?(\d+)/.exec(new URL(url).pathname);
  if (!m) throw new Error("forum: not a topic URL (/t/<slug>/<id>)");
  const json = await getJson<TopicJson>(`${s.base}/t/${m[1]}.json`);
  const posts = (json.post_stream?.posts ?? [])
    /* post_type 1 is a regular post; the rest are moderator actions and whispers. */
    .filter((p) => (p.post_type ?? 1) === 1 && p.cooked)
    .slice(0, Math.min(postLimit, MAX_POSTS))
    .map((p) => ({ author: p.username ?? "unknown", text: clean(p.cooked, MAX_POST), createdAt: (p.created_at ?? "").slice(0, 10), likes: p.like_count ?? 0 }));
  return {
    site: s.key,
    title: json.title,
    url: `${s.base}/t/${m[1]}`,
    category: json.category_id ? `category ${json.category_id}` : "",
    views: json.views ?? 0,
    replies: Math.max(0, (json.posts_count ?? 1) - 1),
    posts,
  };
}

/** Prompt block for search hits. */
export function forumHitsText(hits: ForumHit[]): string {
  if (hits.length === 0) return "(no matching topics)";
  return hits.map((h) => `- [${h.site}] "${h.title}" · ${h.replies} replies · ${h.createdAt} · ${h.url}${h.excerpt ? `\n  ${h.excerpt}` : ""}`).join("\n");
}

/** Prompt block for a topic. Other people's words; the caller marks them untrusted. */
export function forumTopicText(t: ForumTopic): string {
  const head = `[${t.site}] "${t.title}" · ${t.replies} replies · ${t.views} views · ${t.url}`;
  const posts = t.posts.map((p, i) => `  ${i === 0 ? "OPENER" : `reply ${i}`} by ${p.author} (${p.likes} likes, ${p.createdAt}): ${p.text}`).join("\n");
  return `${head}\n${posts || "  (no readable posts)"}`;
}
