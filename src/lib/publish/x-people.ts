import { promises as fs } from "node:fs";
import path from "node:path";
import { pushEvent, updateState } from "@/lib/store";
import { isViewerMode } from "@/lib/viewer/mode";
import { X_ACCOUNT_USER_ID } from "@/lib/publish/x-guard";
import { followOnX, isAuthFailure, xStatus } from "@/lib/publish/x";
import type { SwarmState } from "@/lib/types";

/**
 * Robinhood people rail (operator directive 2026-09-13: "have laura find all
 * robinhood employees for her x analysis as well and their x accounts,
 * follow all of these accounts with the laura x account too and add to
 * context").
 *
 * Discovery is read only and uses only what people say about THEMSELVES in
 * their public X bio: an account counts as Robinhood staff when its own
 * description claims a role at Robinhood (or Robinhood Chain / Robinhood
 * Crypto / Robinhood Markets). We never infer employment from anything else,
 * never scrape LinkedIn or other sites, and never store more than the public
 * handle, name, bio and follower count. "Former"/"ex-" bios are kept as
 * alumni for context but are NOT followed. Parody, fan and "not affiliated"
 * bios are dropped.
 *
 * Sources, all app-bearer GETs on the X API v2:
 *  - seed handles resolved via /2/users/by (leadership + official accounts)
 *  - the people the seeds mention or reply to in their recent tweets
 *  - recent-search authors who mention Robinhood, filtered by their own bio
 *  - the seeds' following lists when the API tier allows (402/403 tolerated)
 *
 * Following is the only write: one follow per FOLLOW_GAP_MS, at most
 * MAX_FOLLOWS_PER_DAY per UTC day, OAuth 1.0a user context. No DMs, no
 * replies, no lists. The ledger lives in data/x-people.json (not state.json)
 * and the digest of current staff joins every cycle's intel context so the
 * swarm knows who at Robinhood is saying what.
 */

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const LEDGER_FILE = path.join(DATA_DIR, "x-people.json");

const DISCOVERY_INTERVAL_MS = 6 * 3600_000;
const DISCOVERY_ERROR_BACKOFF_MS = 60 * 60_000;
const FOLLOW_GAP_MS = 90_000;
const MAX_FOLLOWS_PER_DAY = 25;
const FOLLOW_ERROR_BACKOFF_MS = 30 * 60_000;
const FOLLOW_AUTH_BACKOFF_MS = 6 * 3600_000;
const TIMEOUT_MS = 15_000;
const MAX_PEOPLE = 400;
const MIN_ACCOUNT_AGE_DAYS = 30;

/** Handles whose public role at Robinhood is established (resolved once; ids verified 2026-09-10). */
export const ROBINHOOD_SEEDS: { username: string; id: string | null; label: string }[] = [
  { username: "vladtenev", id: "605700792", label: "CEO, co-founder" },
  { username: "JohannKerbrat", id: "1419089826586918913", label: "GM & SVP, Robinhood Crypto" },
  { username: "RobinhoodApp", id: null, label: "official" },
  { username: "RobinhoodCrypto", id: null, label: "official (crypto)" },
  { username: "RobinhoodChain", id: null, label: "official (chain)" },
];

/**
 * The bio must claim Robinhood in an employment sense, in the person's own
 * words. Classification looks at the text around each "robinhood" mention:
 * a role word shortly before or after it makes a staff claim; a "former"
 * marker in the run-up makes it alumni; an investor marker right before it
 * (or a bare mention with no role) is a customer, backer or fan, not staff.
 */
const ROBINHOOD_RE = /robinhood/gi;
const ROLE_WORDS =
  /\b(at|w\/|with|building|working|leading|lead|head|vp|svp|evp|director|manager|em|engineer|engineering|eng|pm|product|design|designer|research|researcher|scientist|analyst|marketing|comms|communications|legal|counsel|policy|recruiter|recruiting|talent|ops|operations|ceo|cto|cfo|coo|cso|cio|cpo|cmo|chief|officer|president|founder|co-?founder|gm|general manager|staff|team|partnerships|growth|security|data|infra|platform|android|ios|developer|dev|intern|works|employee|early|brokerage|crypto|international)\b[^.•·|;]{0,30}$/i;
const ROLE_AFTER =
  /^\w*\s*(crypto|chain|markets|wallet|gold|legend|comms|l2|international)?\s*(team|employee|engineer|eng|pm|product|design(er)?|legal|comms|marketing|policy|research|security|ops|staff|builder|intern)\b/i;
const FORMER_WORDS =
  /(^|\W)(ex|fmr|former|formerly|fomerly|formely|previously|prev|prior|past|alum|alumni|alumnus|alumna|before|yesterday|was|helped build|built|used to|retired from|left|then)(?=\W|$)/i;
const INVESTOR_WORDS = /\b(investor|investing|invested|angel|backer|backed|portfolio|shareholder|holder|customer|user|fan|trading on|trade on|long|bought|use|using|via|on|for)\s*(in|at|@|:)?\s*$/i;
const EXCLUDE_RE = /\b(parody|fan account|fan page|unofficial|not affiliated|no affiliation|satire|memes?|tracker|bot)\b/i;
const OFFICIAL_RE = /^(robinhoodapp|robinhoodcrypto|robinhoodchain|robinhoodmarkets|robinhoodgold|robinhoodlegend|robinhoodhelp|robinhoodcomms)$/i;
const FORMER_WINDOW = 70;
const ROLE_WINDOW = 40;
const INVESTOR_WINDOW = 24;

/**
 * "Past: CPO @A. CPO @Robinhood." and "prev: GP @A | Founding team @Robinhood"
 * list former roles after a colon; everything up to the next "now/currently"
 * marker belongs to that list.
 */
function underFormerList(prefix: string): boolean {
  const list = /(^|\W)(past|prev|previously|former|formerly|ex|before|yesterday|earlier)\s*:/gi;
  let last = -1;
  for (const m of prefix.matchAll(list)) last = (m.index ?? 0) + m[0].length;
  if (last < 0) return false;
  return !/(^|\W)(now|currently|today|present|current)\b/i.test(prefix.slice(last));
}

function classifyText(bio: string): PersonStatus | null {
  let sawStaffClaim = false;
  let sawFormer = false;
  for (const m of bio.matchAll(ROBINHOOD_RE)) {
    const idx = m.index ?? 0;
    const before = bio.slice(Math.max(0, idx - FORMER_WINDOW), idx);
    const near = bio.slice(Math.max(0, idx - ROLE_WINDOW), idx);
    const after = bio.slice(idx + "robinhood".length, idx + "robinhood".length + 40);
    const investorRun = bio.slice(Math.max(0, idx - INVESTOR_WINDOW), idx);
    if (INVESTOR_WORDS.test(investorRun)) continue;
    /* A sentence or bullet break between the former marker and the mention
       means the marker belonged to an earlier clause. A former marker is a
       claim on its own ("ex-Robinhood", "previously @RobinhoodApp"). */
    const formerRun =
      before
        .replace(/\b(prev|fmr|ex)\.\s/gi, "$1 ")
        .split(/[.•·\n]/)
        .at(-1) ?? before;
    if (FORMER_WORDS.test(formerRun) || underFormerList(bio.slice(0, idx))) {
      sawFormer = true;
      continue;
    }
    if (ROLE_WORDS.test(near) || ROLE_AFTER.test(after)) sawStaffClaim = true;
  }
  if (sawStaffClaim) return "current";
  if (sawFormer) return "former";
  return null;
}

export type PersonStatus = "current" | "former" | "official";

export interface RobinhoodPerson {
  id: string;
  username: string;
  name: string;
  bio: string;
  followers: number;
  status: PersonStatus;
  /** Where discovery first saw them (seed, mention, search, following) */
  via: string;
  firstSeenAt: number;
  lastSeenAt: number;
  followedAt: number | null;
  followError: string | null;
}

export interface PeopleLedger {
  people: RobinhoodPerson[];
  lastDiscoveryAt: number | null;
  lastDiscoveryNote: string | null;
  follows: { at: number; id: string; username: string }[];
}

interface RailState {
  nextDiscoveryAt: number;
  nextFollowAt: number;
  warned: boolean;
}

declare global {
  var __lauraXPeople: RailState | undefined;
}

function rs(): RailState {
  return (globalThis.__lauraXPeople ??= { nextDiscoveryAt: 0, nextFollowAt: 0, warned: false });
}

function log(msg: string): void {
  console.log(`[x-people ${new Date().toISOString()}] ${msg}`);
}

export async function readPeopleLedger(): Promise<PeopleLedger> {
  try {
    const parsed = JSON.parse(await fs.readFile(LEDGER_FILE, "utf8")) as Partial<PeopleLedger>;
    return {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      lastDiscoveryAt: typeof parsed.lastDiscoveryAt === "number" ? parsed.lastDiscoveryAt : null,
      lastDiscoveryNote: typeof parsed.lastDiscoveryNote === "string" ? parsed.lastDiscoveryNote : null,
      follows: Array.isArray(parsed.follows) ? parsed.follows : [],
    };
  } catch {
    return { people: [], lastDiscoveryAt: null, lastDiscoveryNote: null, follows: [] };
  }
}

async function writePeopleLedger(l: PeopleLedger): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const people = [...l.people].sort((a, b) => b.followers - a.followers).slice(0, MAX_PEOPLE);
  await fs.writeFile(
    LEDGER_FILE,
    JSON.stringify({ ...l, people, follows: l.follows.slice(-500) }, null, 2),
    "utf8",
  );
}

interface XUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  created_at?: string;
  public_metrics?: { followers_count?: number };
}

/**
 * Classify a public bio. Returns null when the account should not be
 * recorded at all (no Robinhood claim, or an excluded kind of account).
 */
export function classifyBio(user: { username: string; description?: string; created_at?: string }): PersonStatus | null {
  if (OFFICIAL_RE.test(user.username)) return "official";
  const bio = (user.description ?? "").replace(/\s+/g, " ").trim();
  if (!/robinhood/i.test(bio)) return null;
  if (EXCLUDE_RE.test(bio)) return null;
  if (user.created_at) {
    const ageDays = (Date.now() - new Date(user.created_at).getTime()) / 86_400_000;
    if (ageDays < MIN_ACCOUNT_AGE_DAYS) return null;
  }
  return classifyText(bio);
}

function bearer(): string {
  const t = process.env.X_BEARER_TOKEN ?? "";
  if (!t) throw new Error("X_BEARER_TOKEN missing");
  return t;
}

async function xGet<T>(url: string): Promise<{ status: number; json: T }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${bearer()}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

const USER_FIELDS = "user.fields=description,public_metrics,created_at";

async function resolveSeeds(): Promise<XUser[]> {
  const names = ROBINHOOD_SEEDS.map((s) => s.username).join(",");
  const { status, json } = await xGet<{ data?: XUser[] }>(`https://api.x.com/2/users/by?usernames=${names}&${USER_FIELDS}`);
  if (status === 429) throw new Error("rate limited on /users/by");
  return json.data ?? [];
}

/** People the seeds talk to: mentions and reply targets in their recent tweets. */
async function seedConversations(seedIds: string[]): Promise<{ users: XUser[]; note: string }> {
  const users: XUser[] = [];
  const notes: string[] = [];
  const from = seedIds
    .slice(0, 4)
    .map((id) => `from:${id}`)
    .join(" OR ");
  const url =
    `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(`(${from}) -is:retweet`)}` +
    `&max_results=50&tweet.fields=entities,in_reply_to_user_id&expansions=entities.mentions.username,in_reply_to_user_id&${USER_FIELDS}`;
  const { status, json } = await xGet<{ includes?: { users?: XUser[] }; meta?: { result_count?: number } }>(url);
  if (status === 200) {
    users.push(...(json.includes?.users ?? []));
    notes.push(`seed conversations: ${json.meta?.result_count ?? 0} tweets, ${users.length} people mentioned`);
  } else notes.push(`seed conversations HTTP ${status}`);
  return { users, note: notes.join("; ") };
}

/** Authors who talk about Robinhood right now; the bio filter does the real work. */
async function searchAuthors(): Promise<{ users: XUser[]; note: string }> {
  const query = `(Robinhood OR "Robinhood Chain" OR "Robinhood Crypto" OR @RobinhoodApp OR @RobinhoodCrypto) -is:retweet -is:reply lang:en`;
  const url =
    `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}` +
    `&max_results=100&expansions=author_id&${USER_FIELDS}`;
  const { status, json } = await xGet<{ includes?: { users?: XUser[] }; meta?: { result_count?: number } }>(url);
  if (status !== 200) return { users: [], note: `search HTTP ${status}` };
  const users = json.includes?.users ?? [];
  return { users, note: `search: ${json.meta?.result_count ?? 0} tweets, ${users.length} authors` };
}

/** The seeds' following lists, when the API tier serves them (402/403 are normal on lower tiers). */
async function seedFollowing(seedIds: string[]): Promise<{ users: XUser[]; note: string }> {
  const users: XUser[] = [];
  const notes: string[] = [];
  for (const id of seedIds.slice(0, 2)) {
    const { status, json } = await xGet<{ data?: XUser[] }>(`https://api.x.com/2/users/${id}/following?max_results=1000&${USER_FIELDS}`);
    if (status === 200) {
      users.push(...(json.data ?? []));
      notes.push(`following(${id}): ${json.data?.length ?? 0}`);
    } else {
      notes.push(`following(${id}): HTTP ${status}`);
      if (status === 402 || status === 403) break;
    }
  }
  return { users, note: notes.join("; ") };
}

function mergePeople(ledger: PeopleLedger, users: XUser[], via: string, now: number): number {
  let added = 0;
  const byId = new Map(ledger.people.map((p) => [p.id, p]));
  for (const u of users) {
    if (!u?.id || u.id === X_ACCOUNT_USER_ID) continue;
    const status = classifyBio(u);
    if (!status) continue;
    const bio = (u.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const followers = u.public_metrics?.followers_count ?? 0;
    const existing = byId.get(u.id);
    if (existing) {
      existing.username = u.username;
      existing.name = u.name;
      existing.bio = bio;
      existing.followers = followers;
      existing.status = status;
      existing.lastSeenAt = now;
      continue;
    }
    const person: RobinhoodPerson = {
      id: u.id,
      username: u.username,
      name: u.name,
      bio,
      followers,
      status,
      via,
      firstSeenAt: now,
      lastSeenAt: now,
      followedAt: null,
      followError: null,
    };
    ledger.people.push(person);
    byId.set(u.id, person);
    added++;
  }
  return added;
}

/** One discovery pass: seeds, their conversations, search authors, following lists. */
export async function runPeopleDiscovery(): Promise<{ added: number; total: number; note: string }> {
  const ledger = await readPeopleLedger();
  const now = Date.now();
  const notes: string[] = [];
  let added = 0;

  const seeds = await resolveSeeds();
  for (const s of seeds) {
    const seed = ROBINHOOD_SEEDS.find((x) => x.username.toLowerCase() === s.username.toLowerCase());
    if (seed) seed.id = s.id;
  }
  /* Seeds are staff by operator knowledge, so they bypass the bio test but
     still carry their public bio into the ledger. */
  for (const s of seeds) {
    if (ledger.people.some((p) => p.id === s.id)) continue;
    ledger.people.push({
      id: s.id,
      username: s.username,
      name: s.name,
      bio: (s.description ?? "").replace(/\s+/g, " ").slice(0, 300),
      followers: s.public_metrics?.followers_count ?? 0,
      status: OFFICIAL_RE.test(s.username) ? "official" : "current",
      via: "seed",
      firstSeenAt: now,
      lastSeenAt: now,
      followedAt: null,
      followError: null,
    });
    added++;
  }
  notes.push(`seeds resolved: ${seeds.length}`);
  const seedIds = seeds.map((s) => s.id);

  const conv = await seedConversations(seedIds);
  added += mergePeople(ledger, conv.users, "seed conversation", now);
  notes.push(conv.note);

  const search = await searchAuthors();
  added += mergePeople(ledger, search.users, "search", now);
  notes.push(search.note);

  /* Personal seeds first (their following lists hold colleagues); the
     official accounts follow customers and partners, less signal. */
  const personalFirst = ROBINHOOD_SEEDS.filter((s) => s.id && !OFFICIAL_RE.test(s.username)).map((s) => s.id as string);
  const following = await seedFollowing(personalFirst.length ? personalFirst : seedIds);
  added += mergePeople(ledger, following.users, "seed following", now);
  notes.push(following.note);

  ledger.lastDiscoveryAt = now;
  ledger.lastDiscoveryNote = notes.join(" · ");
  await writePeopleLedger(ledger);
  return { added, total: ledger.people.length, note: ledger.lastDiscoveryNote };
}

function followsToday(ledger: PeopleLedger, now: number): number {
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  return ledger.follows.filter((f) => f.at >= dayStart).length;
}

/** Next account to follow: current staff first by reach, then official accounts. Never alumni. */
export function nextFollowCandidate(ledger: PeopleLedger): RobinhoodPerson | null {
  const eligible = ledger.people.filter((p) => p.followedAt === null && p.followError === null && p.status !== "former");
  eligible.sort((a, b) => {
    const rank = (p: RobinhoodPerson) => (p.status === "current" ? 0 : 1);
    return rank(a) - rank(b) || b.followers - a.followers;
  });
  return eligible[0] ?? null;
}

async function runFollowQueue(): Promise<void> {
  const r = rs();
  const now = Date.now();
  if (now < r.nextFollowAt) return;
  const status = xStatus();
  if (!(status.appKeys && status.accessKeys)) return;

  const ledger = await readPeopleLedger();
  if (followsToday(ledger, now) >= MAX_FOLLOWS_PER_DAY) {
    r.nextFollowAt = new Date(now).setUTCHours(24, 0, 0, 0);
    return;
  }
  const person = nextFollowCandidate(ledger);
  if (!person) {
    r.nextFollowAt = now + 15 * 60_000;
    return;
  }
  r.nextFollowAt = now + FOLLOW_GAP_MS;

  try {
    const res = await followOnX(person.id);
    person.followedAt = now;
    ledger.follows.push({ at: now, id: person.id, username: person.username });
    await writePeopleLedger(ledger);
    log(`followed @${person.username} (${person.status}${res.pending ? ", pending approval" : ""}); ${followsToday(ledger, now)}/${MAX_FOLLOWS_PER_DAY} today`);
    await updateState((st) => {
      pushEvent(st, {
        kind: "x.followed",
        agentId: "scout",
        title: `Followed @${person.username} on X`,
        detail: `${person.name} · ${person.status} Robinhood · ${person.bio.slice(0, 160)} · found via ${person.via}`,
        refId: `xfollow_${person.id}`,
      });
      return null;
    });
  } catch (err) {
    const msg = String(err).slice(0, 200);
    if (isAuthFailure(err) || /403/.test(msg)) {
      r.nextFollowAt = now + FOLLOW_AUTH_BACKOFF_MS;
      log(`follow refused (${msg}); backing off 6h`);
      return;
    }
    if (/429/.test(msg)) {
      r.nextFollowAt = now + FOLLOW_ERROR_BACKOFF_MS;
      log(`rate limited on follow; backing off 30m`);
      return;
    }
    person.followError = msg;
    await writePeopleLedger(ledger);
    log(`follow @${person.username} failed: ${msg}`);
  }
}

/** Scheduler entry: discovery on a 6h stride, one follow per gap. Never throws. */
export async function runXPeopleTick(state: SwarmState): Promise<void> {
  if (isViewerMode()) return;
  if (!state.settings.autoPublishX) return;
  const r = rs();
  if (!process.env.X_BEARER_TOKEN) {
    if (!r.warned) {
      r.warned = true;
      log("idle: X_BEARER_TOKEN not set; Robinhood people discovery off");
    }
    return;
  }
  const now = Date.now();
  if (now >= r.nextDiscoveryAt) {
    r.nextDiscoveryAt = now + DISCOVERY_INTERVAL_MS;
    try {
      const res = await runPeopleDiscovery();
      log(`discovery: +${res.added}, ${res.total} on ledger · ${res.note}`);
    } catch (err) {
      r.nextDiscoveryAt = now + DISCOVERY_ERROR_BACKOFF_MS;
      log(`discovery failed (${String(err).slice(0, 160)}); retry in 1h`);
    }
  }
  try {
    await runFollowQueue();
  } catch (err) {
    log(`follow queue error: ${String(err).slice(0, 160)}`);
  }
}

/** Prompt block for the intel context: who at Robinhood is on X, newest bios first. */
export async function robinhoodPeopleDigest(limit = 18): Promise<string> {
  const ledger = await readPeopleLedger();
  if (ledger.people.length === 0)
    return "ROBINHOOD PEOPLE ON X: discovery has not run yet (seeds: @vladtenev CEO, @JohannKerbrat crypto GM).";
  const current = ledger.people.filter((p) => p.status === "current").sort((a, b) => b.followers - a.followers);
  const official = ledger.people.filter((p) => p.status === "official");
  const former = ledger.people.filter((p) => p.status === "former");
  const followed = ledger.people.filter((p) => p.followedAt !== null).length;
  const lines = current
    .slice(0, limit)
    .map((p) => `- @${p.username} (${p.name}, ${p.followers.toLocaleString()} followers${p.followedAt ? ", followed" : ""}): ${p.bio.slice(0, 140)}`);
  return [
    `ROBINHOOD PEOPLE ON X (${current.length} current staff by their own public bio, ${official.length} official accounts, ${former.length} alumni kept for context; LAURA follows ${followed}. Use for analysis and for reading what Robinhood is building; reply to them like anyone else who tags her, never DM, never claim a relationship that does not exist):`,
    ...lines,
    current.length > limit ? `- …and ${current.length - limit} more on the ledger` : "",
    official.length ? `- official: ${official.map((p) => `@${p.username}`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
