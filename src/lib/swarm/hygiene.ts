import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentId, Draft, ForumPost, ForumThread, HygieneNotice, SwarmState } from "@/lib/types";

/**
 * Sweep, the swarm's hygiene and efficiency agent (operator directive
 * 2026-09-13: "a clean up efficiency agent ... checking for duplicated posts
 * in cafe bar and in logs, checking to make sure agents are not looping the
 * same thing over again and keeping context and memory clean and efficient").
 *
 * Two layers, deliberately split:
 *
 *  1. CODE. `compactState` runs inside every state save (store.ts), after the
 *     SQLite archive has mirrored everything, so the hot store that every
 *     prompt and the console read stays small: exact duplicate Cafe Bar
 *     posts and fallback filler go, drafts nobody published age out, exact
 *     duplicate events collapse, archived threads shrink to their opener and
 *     tail. Nothing is lost (the archive keeps every record forever); the
 *     hot store just stops carrying it. `isRepeatInThread` gives the forum a
 *     gate that refuses a reply restating what the same agent already said
 *     on that tab. `hygieneReport` measures duplication, loops and footprint.
 *     `noticesFor` hands each agent its open notices through agentSystem().
 *
 *  2. MODEL. Sweep runs on a stride, reads the report, and writes at most a
 *     few pointed notices to the agents that are repeating themselves, plus
 *     one assessment for the run log. Sweep never edits code, caps or
 *     guards, never deletes anything itself, never rewrites anyone's
 *     strategy (Coach and Forge own that), and cannot silence an agent: a
 *     notice is context the agent reads, not a switch.
 */

export const SWEEP_STRIDE_MS = 3 * 60 * 60_000;

/* ------------------------------ Retention caps ----------------------------- */

/** Unpublished drafts (approved or rejected) leave the hot store after this long; the archive keeps them. */
export const DRAFT_RETENTION_MS = 72 * 3600_000;
/** Hot-store ceiling for unpublished drafts regardless of age (oldest go first). */
export const MAX_LIVE_DRAFTS = 300;
/** Published drafts kept in the hot store for the console's record. */
export const MAX_PUBLISHED_DRAFTS = 200;
/** Archived Cafe Bar threads kept in the hot store; older ones live in the archive only. */
export const MAX_ARCHIVED_THREADS = 120;
/** Archived threads closed longer ago than this keep only their opener and tail. */
export const ARCHIVED_COMPACT_AFTER_MS = 7 * 24 * 3600_000;
const ARCHIVED_TAIL_POSTS = 2;
/** Fallback filler ("(fallback turn, no LLM ...)") is noise once the round is over. */
const FILLER_RETENTION_MS = 6 * 3600_000;
/** How often the (slightly costly) forum/draft/event scan runs inside saves. */
const COMPACT_EVERY_MS = 5 * 60_000;
/** Notices expire on their own; Sweep re-issues them if the pattern persists. */
export const NOTICE_TTL_MS = 24 * 3600_000;
const MAX_NOTICES = 12;
/** Near-duplicate threshold on 3-word shingles. */
const REPEAT_JACCARD = 0.5;
const MIN_COMPARE_CHARS = 40;

const FILLER_RE = /\(fallback turn, no LLM/i;

/* --------------------------------- Text math -------------------------------- */

export function normalizeText(t: string): string {
  return t.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9$%.\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Shingle sets are memoised per text for the life of one scan (the report compares every pair per author). */
const shingleCache = new Map<string, Set<string>>();
const SHINGLE_CACHE_MAX = 6_000;

function shingles(t: string, n = 3): Set<string> {
  const hit = shingleCache.get(t);
  if (hit) return hit;
  const words = normalizeText(t).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  if (shingleCache.size >= SHINGLE_CACHE_MAX) shingleCache.clear();
  shingleCache.set(t, out);
  return out;
}

/** Jaccard similarity of 3-word shingle sets; 1 for identical text. */
export function similarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return normalizeText(a) === normalizeText(b) ? 1 : 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function isNearDuplicate(a: string, b: string): boolean {
  if (a.length < MIN_COMPARE_CHARS || b.length < MIN_COMPARE_CHARS) return normalizeText(a) === normalizeText(b);
  return similarity(a, b) >= REPEAT_JACCARD;
}

/* ------------------------------ Forum reply gate ---------------------------- */

/**
 * True when `body` restates something already on the tab: an exact copy of
 * any post there, or a near duplicate of one of the same agent's own posts.
 * The forum drops such replies before they land (a loop stopped at the door
 * costs nothing to clean later).
 */
export function isRepeatInThread(thread: ForumThread, agentId: string, body: string): { repeat: boolean; of: ForumPost | null } {
  const norm = normalizeText(body);
  for (const p of thread.posts) {
    if (normalizeText(p.body) === norm) return { repeat: true, of: p };
  }
  for (const p of thread.posts) {
    if (p.agentId !== agentId) continue;
    if (isNearDuplicate(p.body, body)) return { repeat: true, of: p };
  }
  return { repeat: false, of: null };
}

/* -------------------------------- Compaction -------------------------------- */

export interface CompactionResult {
  forumPostsDropped: number;
  forumThreadsDropped: number;
  forumPostsCompacted: number;
  draftsDropped: number;
  eventsDropped: number;
}

export function emptyCompaction(): CompactionResult {
  return { forumPostsDropped: 0, forumThreadsDropped: 0, forumPostsCompacted: 0, draftsDropped: 0, eventsDropped: 0 };
}

declare global {
  var __lauraHygieneLastCompactAt: number | undefined;
  var __lauraHygieneBoard: Map<string, HygieneNotice[]> | undefined;
}

/** Draft ids other records point at; those drafts stay whatever their age. */
function referencedDraftIds(state: SwarmState): Set<string> {
  const ids = new Set<string>();
  for (const p of state.forgeProjects ?? []) if (p.announceDraftId) ids.add(p.announceDraftId);
  return ids;
}

function compactDrafts(state: SwarmState, now: number, keep: Set<string>): number {
  const before = state.drafts.length;
  const published = state.drafts.filter((d) => d.status === "published").sort((a, b) => a.createdAt - b.createdAt);
  const live = state.drafts.filter((d) => d.status !== "published").sort((a, b) => a.createdAt - b.createdAt);
  const keptLive: Draft[] = [];
  for (const d of live) {
    const protectedDraft = d.status === "pending" || keep.has(d.id);
    if (!protectedDraft && now - d.createdAt > DRAFT_RETENTION_MS) continue;
    keptLive.push(d);
  }
  const overflow = Math.max(0, keptLive.length - MAX_LIVE_DRAFTS);
  const trimmedLive = overflow > 0 ? keptLive.filter((d, i) => i >= overflow || d.status === "pending" || keep.has(d.id)) : keptLive;
  const trimmedPublished = published.slice(-MAX_PUBLISHED_DRAFTS);
  /* In place: long flows hold references to these arrays (ctx.drafts). */
  state.drafts.splice(0, state.drafts.length, ...[...trimmedPublished, ...trimmedLive].sort((a, b) => a.createdAt - b.createdAt));
  return before - state.drafts.length;
}

function compactForum(state: SwarmState, now: number): Pick<CompactionResult, "forumPostsDropped" | "forumThreadsDropped" | "forumPostsCompacted"> {
  const out = { forumPostsDropped: 0, forumThreadsDropped: 0, forumPostsCompacted: 0 };
  const threads = state.forum ?? [];
  for (const t of threads) {
    const seen = new Set<string>();
    const kept: ForumPost[] = [];
    t.posts.forEach((p, i) => {
      const norm = normalizeText(p.body);
      if (i > 0 && seen.has(norm)) {
        out.forumPostsDropped++;
        return;
      }
      if (i > 0 && FILLER_RE.test(p.body) && now - p.ts > FILLER_RETENTION_MS) {
        out.forumPostsDropped++;
        return;
      }
      seen.add(norm);
      kept.push(p);
    });
    t.posts.splice(0, t.posts.length, ...kept);
    if (t.status === "archived" && (t.closedAt ?? t.posts.at(-1)?.ts ?? t.createdAt) < now - ARCHIVED_COMPACT_AFTER_MS && t.posts.length > 1 + ARCHIVED_TAIL_POSTS) {
      const compacted = t.posts.length - (1 + ARCHIVED_TAIL_POSTS);
      t.posts.splice(0, t.posts.length, t.posts[0], ...t.posts.slice(-ARCHIVED_TAIL_POSTS));
      t.compactedPosts = (t.compactedPosts ?? 0) + compacted;
      out.forumPostsCompacted += compacted;
    }
  }
  const archived = threads.filter((t) => t.status === "archived").sort((a, b) => (a.closedAt ?? a.createdAt) - (b.closedAt ?? b.createdAt));
  if (archived.length > MAX_ARCHIVED_THREADS) {
    const drop = new Set(archived.slice(0, archived.length - MAX_ARCHIVED_THREADS).map((t) => t.id));
    threads.splice(0, threads.length, ...threads.filter((t) => !drop.has(t.id)));
    out.forumThreadsDropped = drop.size;
  }
  return out;
}

function compactEvents(state: SwarmState): number {
  const before = state.events.length;
  const seen = new Set<string>();
  const kept = [];
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i];
    const key = `${e.agentId}|${e.kind}|${e.title}|${e.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(e);
  }
  kept.reverse();
  state.events.splice(0, state.events.length, ...kept);
  return before - state.events.length;
}

/**
 * Hot-store compaction, run by saveState after the archive mirrored the
 * state. Idempotent and merge-proof: a record another writer re-adds is
 * removed again on the next save. Throttled to once per COMPACT_EVERY_MS
 * unless `force` (Sweep's own run). Never throws.
 */
export function compactState(state: SwarmState, now = Date.now(), force = false): CompactionResult {
  const last = globalThis.__lauraHygieneLastCompactAt ?? 0;
  if (!force && now - last < COMPACT_EVERY_MS) return emptyCompaction();
  globalThis.__lauraHygieneLastCompactAt = now;
  try {
    const keep = referencedDraftIds(state);
    const draftsDropped = compactDrafts(state, now, keep);
    const forum = compactForum(state, now);
    const eventsDropped = compactEvents(state);
    if (state.hygieneNotices) state.hygieneNotices = state.hygieneNotices.filter((n) => n.expiresAt > now).slice(-MAX_NOTICES);
    return { ...forum, draftsDropped, eventsDropped };
  } catch (err) {
    console.log(`[hygiene ${new Date().toISOString()}] compaction failed: ${String(err).slice(0, 200)}`);
    return emptyCompaction();
  }
}

/* ---------------------------------- Report ---------------------------------- */

export type LoopKind = "forum-repeat" | "forum-template" | "draft-repeat" | "skip-record-repeat" | "draft-duplicate-veto" | "error-stuck" | "event-repeat";

/** The interim skip-record template some strategies file when a gate is unmet. */
const SKIP_RECORD_RE = /^\s*(skip\s*-|gate unmet:)/i;

export interface LoopFinding {
  agentId: string;
  kind: LoopKind;
  count: number;
  /** Where it happened (thread title, draft kind, step label). */
  where: string;
  /** A short quote so the agent recognises the pattern. */
  sample: string;
}

export interface HygieneReport {
  at: number;
  footprint: { totalBytes: number; streams: Array<{ key: string; bytes: number; count: number }> };
  forum: { threads: number; open: number; posts: number; exactDuplicates: number; filler: number };
  drafts: { total: number; approvedUnpublished: number; olderThanRetention: number; duplicateGroups: number };
  events: { total: number; exactDuplicates: number };
  loops: LoopFinding[];
}

const EVENT_REPEAT_IGNORE = new Set(["forum.post", "forum.thread", "draft.created", "draft.approved", "cycle.started", "cycle.finished", "onchain.observed", "grade.stamped"]);

function pushLoop(loops: LoopFinding[], f: LoopFinding): void {
  const existing = loops.find((l) => l.agentId === f.agentId && l.kind === f.kind && l.where === f.where);
  if (existing) existing.count = Math.max(existing.count, f.count);
  else loops.push(f);
}

/** Read-only scan of the state; the numbers Sweep reasons from. */
export function hygieneReport(state: SwarmState, now = Date.now()): HygieneReport {
  const streams = (Object.keys(state) as Array<keyof SwarmState>)
    .map((key) => {
      const v = state[key];
      return { key: String(key), bytes: JSON.stringify(v ?? null).length, count: Array.isArray(v) ? v.length : 1 };
    })
    .sort((a, b) => b.bytes - a.bytes);
  const totalBytes = streams.reduce((s, x) => s + x.bytes, 0);

  const threads = state.forum ?? [];
  let posts = 0;
  let exactDuplicates = 0;
  let filler = 0;
  const loops: LoopFinding[] = [];
  const openings = new Map<string, { count: number; sample: string; agentId: string }>();
  const dayAgo = now - 48 * 3600_000;
  for (const t of threads) {
    const seen = new Set<string>();
    const byAgent = new Map<string, ForumPost[]>();
    for (const p of t.posts) {
      posts++;
      const norm = normalizeText(p.body);
      if (seen.has(norm)) exactDuplicates++;
      seen.add(norm);
      if (FILLER_RE.test(p.body)) {
        /* No model wrote this; compaction removes it and nobody is told off for it. */
        filler++;
        continue;
      }
      const mine = byAgent.get(p.agentId) ?? [];
      const repeats = mine.filter((q) => isNearDuplicate(q.body, p.body)).length;
      if (repeats > 0) pushLoop(loops, { agentId: p.agentId, kind: "forum-repeat", count: repeats + 1, where: t.title.slice(0, 80), sample: p.body.slice(0, 140) });
      mine.push(p);
      byAgent.set(p.agentId, mine);
      if (p.ts >= dayAgo && p.body.length >= MIN_COMPARE_CHARS) {
        const key = `${p.agentId}|${normalizeText(p.body).slice(0, 80)}`;
        const o = openings.get(key) ?? { count: 0, sample: p.body.slice(0, 140), agentId: p.agentId };
        o.count++;
        openings.set(key, o);
      }
    }
  }
  for (const o of openings.values()) {
    if (o.count >= 3) pushLoop(loops, { agentId: o.agentId, kind: "forum-template", count: o.count, where: "several tabs, last 48h", sample: o.sample });
  }

  const drafts = state.drafts;
  const approvedUnpublished = drafts.filter((d) => d.status === "approved").length;
  const olderThanRetention = drafts.filter((d) => d.status !== "published" && d.status !== "pending" && now - d.createdAt > DRAFT_RETENTION_MS).length;
  let duplicateGroups = 0;
  const recentDrafts = drafts.filter((d) => now - d.createdAt < 72 * 3600_000);
  const byAuthor = new Map<string, Draft[]>();
  for (const d of recentDrafts) byAuthor.set(d.agentId, [...(byAuthor.get(d.agentId) ?? []), d]);
  for (const [agentId, list] of byAuthor) {
    const grouped = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      if (grouped.has(list[i].id)) continue;
      const near = list.slice(i + 1).filter((o) => isNearDuplicate(list[i].body, o.body));
      if (near.length > 0) {
        duplicateGroups++;
        for (const n of near) grouped.add(n.id);
        const skipRecord = SKIP_RECORD_RE.test(list[i].body) || SKIP_RECORD_RE.test(list[i].title);
        pushLoop(loops, {
          agentId,
          kind: skipRecord ? "skip-record-repeat" : "draft-repeat",
          count: near.length + 1,
          where: skipRecord ? "skip records, last 72h" : `${list[i].kind} drafts, last 72h`,
          sample: list[i].body.slice(0, 140),
        });
      }
    }
    const dupVetoes = list.filter((d) => d.status === "rejected" && /duplicat/i.test(d.reviewerNote ?? ""));
    if (dupVetoes.length >= 2) pushLoop(loops, { agentId, kind: "draft-duplicate-veto", count: dupVetoes.length, where: "auditor vetoes for duplication, last 72h", sample: (dupVetoes[0].reviewerNote ?? "").slice(0, 140) });
  }

  const evSeen = new Map<string, number>();
  let eventDuplicates = 0;
  const evTitles = new Map<string, { count: number; agentId: string; kind: string; title: string }>();
  for (const e of state.events) {
    const key = `${e.agentId}|${e.kind}|${e.title}|${e.detail}`;
    evSeen.set(key, (evSeen.get(key) ?? 0) + 1);
    if (now - e.ts < 24 * 3600_000 && !EVENT_REPEAT_IGNORE.has(e.kind)) {
      const k2 = `${e.agentId}|${e.kind}|${e.title}`;
      const o = evTitles.get(k2) ?? { count: 0, agentId: e.agentId, kind: e.kind, title: e.title };
      o.count++;
      evTitles.set(k2, o);
    }
  }
  for (const n of evSeen.values()) if (n > 1) eventDuplicates += n - 1;
  for (const o of evTitles.values()) {
    if (o.count >= 5) pushLoop(loops, { agentId: o.agentId, kind: "event-repeat", count: o.count, where: `${o.kind} events, last 24h`, sample: o.title.slice(0, 140) });
  }

  const recentRuns = state.runs.slice(-6);
  const errKeys = new Map<string, { count: number; agentId: string; label: string; sample: string }>();
  for (const r of recentRuns) {
    for (const s of r.steps) {
      if (s.status !== "error") continue;
      const key = `${s.agentId}|${s.label}|${s.summary.slice(0, 80)}`;
      const o = errKeys.get(key) ?? { count: 0, agentId: s.agentId, label: s.label, sample: s.summary.slice(0, 140) };
      o.count++;
      errKeys.set(key, o);
    }
  }
  for (const o of errKeys.values()) {
    if (o.count >= 3) pushLoop(loops, { agentId: o.agentId, kind: "error-stuck", count: o.count, where: `${o.label} step, last ${recentRuns.length} cycles`, sample: o.sample });
  }

  loops.sort((a, b) => b.count - a.count);
  return {
    at: now,
    footprint: { totalBytes, streams: streams.slice(0, 8) },
    forum: { threads: threads.length, open: threads.filter((t) => t.status === "open").length, posts, exactDuplicates, filler },
    drafts: { total: drafts.length, approvedUnpublished, olderThanRetention, duplicateGroups },
    events: { total: state.events.length, exactDuplicates: eventDuplicates },
    loops: loops.slice(0, 20),
  };
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

export function hygieneDigest(r: HygieneReport, agentName: (id: string) => string): string {
  const lines = [
    `Hot store: ${kb(r.footprint.totalBytes)} total; largest streams ${r.footprint.streams.slice(0, 5).map((s) => `${s.key} ${kb(s.bytes)} (${s.count})`).join(", ")}.`,
    `Cafe Bar: ${r.forum.threads} threads (${r.forum.open} open), ${r.forum.posts} posts, ${r.forum.exactDuplicates} exact duplicates, ${r.forum.filler} fallback filler posts.`,
    `Drafts: ${r.drafts.total} in the hot store, ${r.drafts.approvedUnpublished} approved but never published, ${r.drafts.olderThanRetention} past the ${DRAFT_RETENTION_MS / 3600_000}h retention, ${r.drafts.duplicateGroups} near-duplicate groups in the last 72h.`,
    `Events: ${r.events.total}, ${r.events.exactDuplicates} exact duplicates.`,
    r.loops.length
      ? `Loops (agent, pattern, count, where):\n${r.loops.map((l) => `- ${agentName(l.agentId)} (${l.agentId}): ${l.kind} x${l.count} in ${l.where}. Sample: "${l.sample.replace(/\s+/g, " ")}"`).join("\n")}`
      : "Loops: none detected.",
  ];
  return lines.join("\n");
}

/* --------------------------------- Notices ---------------------------------- */

function noticeText(f: LoopFinding, agentName: string): string {
  const sample = `"${f.sample.replace(/\s+/g, " ").slice(0, 100)}"`;
  switch (f.kind) {
    case "forum-repeat":
      return `${agentName}: you posted ${f.count} near-identical replies on the tab "${f.where}" (${sample}). A point already on the tab is made; add a new number or a new source, or let the tab rest.`;
    case "forum-template":
      return `${agentName}: ${f.count} of your bar posts in 48h open with the same words (${sample}). Say each thing once, in words shaped by the tab, not by a template.`;
    case "draft-repeat":
      return `${agentName}: ${f.count} of your recent ${f.where} say the same thing (${sample}). One draft per idea; when it was vetoed, change the idea, not the wording.`;
    case "skip-record-repeat":
      return `${agentName}: ${f.count} skip records in 72h with the same gate reason (${sample}). A skip record is a verdict, not a heartbeat: when the gate is unmet for the same reason as your last record, file nothing.`;
    case "draft-duplicate-veto":
      return `${agentName}: the Auditor vetoed ${f.count} of your posts in 72h as duplicates of earlier posts (${sample}). Read THE ACCOUNT ON X before drafting and pick a subject the account has not covered.`;
    case "error-stuck":
      return `${agentName}: the same error hit your "${f.where}" ${f.count} times (${sample}). The next attempt must change something, or skip with the reason.`;
    case "event-repeat":
      return `${agentName}: ${f.count} identical "${f.sample.slice(0, 60)}" entries in 24h (${f.where}). Log a thing once; repeats are noise the whole swarm reads.`;
    default: {
      const _exhaustive: never = f.kind;
      return _exhaustive;
    }
  }
}

/** Code-written notices from the report: one per (agent, pattern), 24h, replacing older ones of the same shape. */
export function codeNotices(report: HygieneReport, agentName: (id: string) => string, now = Date.now()): HygieneNotice[] {
  const out: HygieneNotice[] = [];
  for (const f of report.loops) {
    if (f.kind === "forum-repeat" && f.count < 3) continue;
    if ((f.kind === "draft-repeat" || f.kind === "skip-record-repeat") && f.count < 3) continue;
    out.push({
      id: `hn_${randomUUID().slice(0, 8)}`,
      agentId: f.agentId,
      ts: now,
      expiresAt: now + NOTICE_TTL_MS,
      kind: f.kind,
      text: noticeText(f, agentName(f.agentId)),
      source: "code",
    });
  }
  return out.slice(0, 6);
}

/** Merges new notices into state: same (agent, kind) replaces, expired ones drop, cap MAX_NOTICES. */
export function applyNotices(state: SwarmState, fresh: HygieneNotice[], now = Date.now()): void {
  const live = (state.hygieneNotices ?? []).filter((n) => n.expiresAt > now);
  const replaced = live.filter((n) => !fresh.some((f) => f.agentId === n.agentId && f.kind === n.kind));
  state.hygieneNotices = [...replaced, ...fresh].sort((a, b) => a.ts - b.ts).slice(-MAX_NOTICES);
  refreshHygieneBoard(state, now);
}

/**
 * The board agentSystem() reads: the open notices per agent, refreshed from
 * state at the start of every cycle and forum round (flows load state once,
 * so a process-wide map is the cheapest way to reach every prompt builder).
 */
export function refreshHygieneBoard(state: SwarmState, now = Date.now()): void {
  const board = new Map<string, HygieneNotice[]>();
  for (const n of state.hygieneNotices ?? []) {
    if (n.expiresAt <= now) continue;
    board.set(n.agentId, [...(board.get(n.agentId) ?? []), n]);
  }
  globalThis.__lauraHygieneBoard = board;
}

export function noticesFor(agentId: AgentId | string): HygieneNotice[] {
  return globalThis.__lauraHygieneBoard?.get(agentId) ?? [];
}

/* ------------------------------ Sweep, the model ---------------------------- */

export const sweepSchema = z.object({
  /** One paragraph: what is clean, what is repeating, what the swarm should stop doing. */
  assessment: z.string().min(20).max(900),
  /** Pointed notes to the agents that are looping; at most four, each to one agent. */
  notes: z
    .array(
      z.object({
        agentId: z.string().min(2).max(40),
        note: z.string().min(20).max(320),
      }),
    )
    .max(4),
});

export type SweepOut = z.infer<typeof sweepSchema>;

export function sweepPrompt(input: { today: string; report: string; roster: string; compaction: CompactionResult; openNotices: string }): string {
  const c = input.compaction;
  return [
    `TODAY (UTC): ${input.today}.`,
    `HYGIENE REPORT (measured in code this run)\n${input.report}`,
    `COMPACTION THIS RUN (done in code before you read this; the archive keeps every record)\n- Cafe Bar posts dropped as exact duplicates or fallback filler: ${c.forumPostsDropped}\n- archived threads left the hot store: ${c.forumThreadsDropped}; posts compacted inside old archived threads: ${c.forumPostsCompacted}\n- drafts aged out of the hot store: ${c.draftsDropped}\n- duplicate events collapsed: ${c.eventsDropped}`,
    `OPEN NOTICES (already in front of the agents named; do not repeat one that is still open unless the pattern grew)\n${input.openNotices}`,
    `ROSTER\n${input.roster}`,
    `WRITE the assessment (what is clean, which agents are repeating themselves and where, whether the store is growing in a stream it should not) and at most four notes. A note goes to ONE agent id from the roster, quotes the pattern in a few words, and says what to do instead in one sentence. Notes are for loops the code found or one you can see in the report; never for style, never for strategy (Coach and Forge own strategy), never to praise. When nothing is looping, return no notes and say so in the assessment.`,
  ].join("\n\n");
}

export function sweepMock(report: HygieneReport): SweepOut {
  return {
    assessment: `Deterministic fallback (no live model): ${report.loops.length} loop pattern(s) measured in code, ${report.forum.exactDuplicates} exact duplicate bar posts, ${report.drafts.olderThanRetention} drafts past retention; code notices issued where a pattern crossed the threshold.`,
    notes: [],
  };
}
