import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AgentId,
  CycleRun,
  DailyGrade,
  Draft,
  ForumPost,
  ForumThread,
  IntelSnapshot,
  LaunchProposal,
  Lesson,
  MetricsSnapshot,
  MilestoneRecord,
  ResearchBrief,
  StrategyProposal,
  SwarmEvent,
  SwarmState,
} from "@/lib/types";

/**
 * LAURA's deep memory: an append-only SQLite archive under data/archive/.
 *
 * The hot store (data/state.json) caps its arrays so the console stays fast —
 * runs at 200, events at 1500, lessons at 60, notebook at 150 — which means
 * old context is silently destroyed. This archive keeps EVERYTHING: every
 * item is upserted here on every state save (keyed by stream+id, so mutable
 * items like drafts keep their latest revision while nothing is ever
 * deleted), and the full history stays queryable for prompts via
 * `recentOutputs` / `searchArchive` / `gradeHistory` long after the hot
 * store evicted it.
 *
 * better-sqlite3 is synchronous and fast (WAL mode); the whole upsert pass
 * for a full state is a few milliseconds because unchanged rows are skipped.
 * The DB lives in the git-ignored data dir. FTS5 keeps a full-text index in
 * sync via triggers.
 */

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const DB_FILE = path.join(ARCHIVE_DIR, "archive.db");

export type ArchiveStream =
  | "runs"
  | "grades"
  | "events"
  | "drafts"
  | "proposals"
  | "launches"
  | "lessons"
  | "briefs"
  | "milestones"
  | "notebook"
  | "metrics"
  | "intel"
  | "forum";

export interface ArchiveRow {
  stream: ArchiveStream;
  id: string;
  cycleId: string | null;
  agentId: string | null;
  ts: number;
  /** Full original object, JSON-encoded. */
  json: string;
  /** Human-readable text used for full-text search. */
  text: string;
}

/* Survive Next.js dev HMR re-imports: one connection per process. */
declare global {
  var __lauraArchiveDb: Database.Database | undefined;
}

function db(): Database.Database {
  if (globalThis.__lauraArchiveDb) return globalThis.__lauraArchiveDb;
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const d = new Database(DB_FILE);
  d.pragma("journal_mode = WAL");
  d.pragma("synchronous = NORMAL");
  d.pragma("busy_timeout = 5000");
  d.exec(`
    CREATE TABLE IF NOT EXISTS items (
      stream     TEXT NOT NULL,
      id         TEXT NOT NULL,
      cycle_id   TEXT,
      agent_id   TEXT,
      ts         INTEGER NOT NULL,
      json       TEXT NOT NULL,
      text       TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (stream, id)
    );
    CREATE INDEX IF NOT EXISTS idx_items_stream_ts ON items(stream, ts);
    CREATE INDEX IF NOT EXISTS idx_items_stream_agent_ts ON items(stream, agent_id, ts);
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      text, content='items', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO items_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  globalThis.__lauraArchiveDb = d;
  return d;
}

/* ------------------------------- Writing ---------------------------------- */

/** Upsert; unchanged rows are skipped so repeated saves cost almost nothing. */
const UPSERT_SQL = `
  INSERT INTO items (stream, id, cycle_id, agent_id, ts, json, text, updated_at)
  VALUES (@stream, @id, @cycleId, @agentId, @ts, @json, @text, @now)
  ON CONFLICT (stream, id) DO UPDATE SET
    cycle_id = excluded.cycle_id,
    agent_id = excluded.agent_id,
    ts = excluded.ts,
    json = excluded.json,
    text = excluded.text,
    updated_at = excluded.updated_at
  WHERE items.json <> excluded.json
`;

function upsertMany(rows: ArchiveRow[]): void {
  if (rows.length === 0) return;
  const d = db();
  const stmt = d.prepare(UPSERT_SQL);
  const now = Date.now();
  const tx = d.transaction((batch: ArchiveRow[]) => {
    for (const r of batch) stmt.run({ ...r, now });
  });
  tx(rows);
}

function clip(s: string, max = 24_000): string {
  return s.length <= max ? s : s.slice(0, max);
}

function runRow(r: CycleRun): ArchiveRow {
  const steps = r.steps.map((s) => `${s.agentId} ${s.label} [${s.status}]: ${s.summary}`).join("\n");
  return {
    stream: "runs",
    id: r.id,
    cycleId: r.id,
    agentId: null,
    ts: r.startedAt,
    json: JSON.stringify(r),
    text: clip(`cycle ${r.id} (${r.trigger}) via ${r.llmProvider}: ${r.draftsCreated} drafts, ${r.proposalsCreated} proposals${r.error ? ` ERROR ${r.error}` : ""}\n${steps}`),
  };
}

function gradeRow(g: DailyGrade): ArchiveRow {
  const comps = g.components.map((c) => `${c.label} ${c.score.toFixed(0)}/100: ${c.detail}`).join("\n");
  return {
    stream: "grades",
    id: g.id,
    cycleId: null,
    agentId: null,
    ts: g.ts,
    json: JSON.stringify(g),
    text: clip(`grade ${g.date} ${g.letter} ${g.score.toFixed(1)}: ${g.summary}\n${comps}`),
  };
}

function eventRow(e: SwarmEvent): ArchiveRow {
  return {
    stream: "events",
    id: e.id,
    cycleId: null,
    agentId: e.agentId,
    ts: e.ts,
    json: JSON.stringify(e),
    text: clip(`${e.kind} ${e.title}: ${e.detail}`),
  };
}

function draftRow(d: Draft): ArchiveRow {
  return {
    stream: "drafts",
    id: d.id,
    cycleId: d.cycleId,
    agentId: d.agentId,
    ts: d.createdAt,
    json: JSON.stringify(d),
    text: clip(`${d.kind} for ${d.channel} [${d.status}] "${d.title}"\n${d.body}\nrationale: ${d.rationale}${d.reviewerNote ? `\nreviewer: ${d.reviewerNote}` : ""}`),
  };
}

function proposalRow(p: StrategyProposal): ArchiveRow {
  return {
    stream: "proposals",
    id: p.id,
    cycleId: p.cycleId,
    agentId: p.agentId,
    ts: p.createdAt,
    json: JSON.stringify(p),
    text: clip(`strategy v${p.fromVersion + 1} proposal for ${p.agentId} [${p.status}]: ${p.proposedStrategy}\nrationale: ${p.rationale}\nevidence: ${p.evidence.join("; ")}`),
  };
}

function launchRow(l: LaunchProposal): ArchiveRow {
  return {
    stream: "launches",
    id: l.id,
    cycleId: l.cycleId,
    agentId: "mint",
    ts: l.createdAt,
    json: JSON.stringify(l),
    text: clip(`launch ${l.name} ($${l.symbol}) [${l.status}]${l.message ? ` message: ${l.message}` : ""}\nconcept: ${l.concept}\nrationale: ${l.rationale}`),
  };
}

function lessonRow(l: Lesson): ArchiveRow {
  return {
    stream: "lessons",
    id: l.id,
    cycleId: l.cycleId,
    agentId: "coach",
    ts: l.ts,
    json: JSON.stringify(l),
    text: clip(`lesson: ${l.text} (evidence: ${l.evidence})`),
  };
}

function briefRow(b: ResearchBrief): ArchiveRow {
  return {
    stream: "briefs",
    id: b.id,
    cycleId: b.cycleId,
    agentId: "scout",
    ts: b.createdAt,
    json: JSON.stringify(b),
    text: clip(`brief: ${b.headline}\n${b.bullets.join("\n")}`),
  };
}

function milestoneRow(m: MilestoneRecord): ArchiveRow {
  return {
    stream: "milestones",
    id: m.id,
    cycleId: null,
    agentId: null,
    ts: m.reachedAt,
    json: JSON.stringify(m),
    text: `milestone: ${m.label} at market cap $${Math.round(m.marketCapUsd).toLocaleString()}`,
  };
}

function intelRow(s: IntelSnapshot): ArchiveRow {
  const mentions = s.x ? `${s.x.mentionCount24h} mentions, ${s.x.engagement24h} engagements` : "x unavailable";
  return {
    stream: "intel",
    id: `i_${s.ts}`,
    cycleId: null,
    agentId: null,
    ts: s.ts,
    json: JSON.stringify(s),
    text: clip(
      `intel ${new Date(s.ts).toISOString()}: ${mentions}; holders ${s.holderCount ?? "n/a"}; eth $${s.ethUsd ?? "n/a"}; sources ${s.sources.join(",")}${s.x?.topMentions.length ? `\n${s.x.topMentions.map((t) => `@${t.author}: ${t.text}`).join("\n")}` : ""}`,
    ),
  };
}

function metricsRow(m: MetricsSnapshot): ArchiveRow {
  return {
    stream: "metrics",
    id: `m_${m.ts}`,
    cycleId: null,
    agentId: null,
    ts: m.ts,
    json: JSON.stringify(m),
    text: `metrics ${new Date(m.ts).toISOString()} source ${m.source} price $${m.priceUsd}`,
  };
}

/** Thread metadata row; post bodies live in their own rows so each survives independently. */
function forumThreadRow(t: ForumThread): ArchiveRow {
  const { posts: _posts, ...meta } = t;
  return {
    stream: "forum",
    id: t.id,
    cycleId: null,
    agentId: null,
    ts: t.createdAt,
    json: JSON.stringify({ ...meta, postCount: t.posts.length }),
    text: clip(
      `bar thread [${t.tag}] "${t.title}" by ${t.createdBy} (${t.status}${t.closedReason ? ` · closed: ${t.closedReason}` : ""})`,
    ),
  };
}

function forumPostRow(t: ForumThread, p: ForumPost): ArchiveRow {
  return {
    stream: "forum",
    id: p.id,
    cycleId: null,
    agentId: p.agentId,
    ts: p.ts,
    json: JSON.stringify(p),
    text: clip(`bar post in "${t.title}" by ${p.agentId} (round ${p.roundId}): ${p.body}`),
  };
}

/**
 * Archive every stream of the hot state. Called from saveState after each
 * successful write; also serves as the one-shot backfill (first call in a
 * fresh archive inserts the whole current history). Never throws — archive
 * failures must not break the hot path.
 */
export function archiveState(state: SwarmState): void {
  try {
    upsertMany([
      ...state.runs.map(runRow),
      ...state.grades.map(gradeRow),
      ...state.events.map(eventRow),
      ...state.drafts.map(draftRow),
      ...state.proposals.map(proposalRow),
      ...state.launches.map(launchRow),
      ...state.lessons.map(lessonRow),
      ...state.researchBriefs.map(briefRow),
      ...state.milestones.map(milestoneRow),
      ...state.metricsHistory.map(metricsRow),
      ...(state.intelHistory ?? []).map(intelRow),
      ...(state.forum ?? []).flatMap((t) => [forumThreadRow(t), ...t.posts.map((p) => forumPostRow(t, p))]),
    ]);
  } catch (err) {
    console.error(`[archive] state archive failed: ${String(err)}`);
  }
}

/** Notebook entries are archived at write time so topic-replace and the 150-entry cap never destroy a note. */
export function archiveNotebookEntries(
  entries: { id: string; ts: number; cycleId: string; topic: string; text: string }[],
): void {
  try {
    upsertMany(
      entries.map((e) => ({
        stream: "notebook" as const,
        id: e.id,
        cycleId: e.cycleId,
        agentId: "coach",
        ts: e.ts,
        json: JSON.stringify(e),
        text: clip(`[${e.topic}] ${e.text}`),
      })),
    );
  } catch (err) {
    console.error(`[archive] notebook archive failed: ${String(err)}`);
  }
}

/* ------------------------------ Retrieval --------------------------------- */

export interface ArchiveHit {
  stream: ArchiveStream;
  id: string;
  cycleId: string | null;
  agentId: string | null;
  ts: number;
  /** Parsed original object. */
  item: unknown;
  /** FTS snippet when the hit came from a text search. */
  snippet?: string;
}

interface ItemRowRaw {
  stream: ArchiveStream;
  id: string;
  cycle_id: string | null;
  agent_id: string | null;
  ts: number;
  json: string;
  snippet?: string;
}

function toHit(r: ItemRowRaw): ArchiveHit {
  return {
    stream: r.stream,
    id: r.id,
    cycleId: r.cycle_id,
    agentId: r.agent_id,
    ts: r.ts,
    item: JSON.parse(r.json) as unknown,
    ...(r.snippet !== undefined ? { snippet: r.snippet } : {}),
  };
}

/** Latest archived drafts by one agent, newest first — deeper than the hot store keeps. */
export function recentOutputs(agentId: AgentId, n = 5): ArchiveHit[] {
  try {
    const rows = db()
      .prepare(
        `SELECT stream, id, cycle_id, agent_id, ts, json FROM items
         WHERE stream = 'drafts' AND agent_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(agentId, n) as ItemRowRaw[];
    return rows.map(toHit);
  } catch (err) {
    console.error(`[archive] recentOutputs failed: ${String(err)}`);
    return [];
  }
}

/** Full-text search across every archived stream (FTS5, LIKE fallback). */
export function searchArchive(query: string, n = 8, streams?: ArchiveStream[]): ArchiveHit[] {
  const streamFilter = streams?.length
    ? ` AND items.stream IN (${streams.map(() => "?").join(",")})`
    : "";
  const streamArgs = streams ?? [];
  try {
    /* Quote each token so user text can never be FTS5 syntax. */
    const match = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replaceAll('"', '""')}"`)
      .join(" ");
    if (!match) return [];
    const rows = db()
      .prepare(
        `SELECT items.stream, items.id, items.cycle_id, items.agent_id, items.ts, items.json,
                snippet(items_fts, 0, '[', ']', ' … ', 16) AS snippet
         FROM items_fts JOIN items ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?${streamFilter}
         ORDER BY rank LIMIT ?`,
      )
      .all(match, ...streamArgs, n) as ItemRowRaw[];
    return rows.map(toHit);
  } catch {
    /* FTS unavailable or query unparseable: token LIKE fallback. */
    try {
      const like = `%${query.trim().split(/\s+/)[0] ?? ""}%`;
      const rows = db()
        .prepare(
          `SELECT stream, id, cycle_id, agent_id, ts, json FROM items
           WHERE text LIKE ?${streams?.length ? ` AND stream IN (${streams.map(() => "?").join(",")})` : ""}
           ORDER BY ts DESC LIMIT ?`,
        )
        .all(like, ...streamArgs, n) as ItemRowRaw[];
      return rows.map(toHit);
    } catch (err) {
      console.error(`[archive] searchArchive failed: ${String(err)}`);
      return [];
    }
  }
}

/** Grade history, newest first, from the archive (survives any hot-store cap). */
export function gradeHistory(n = 30): ArchiveHit[] {
  try {
    const rows = db()
      .prepare(
        `SELECT stream, id, cycle_id, agent_id, ts, json FROM items
         WHERE stream = 'grades' ORDER BY ts DESC LIMIT ?`,
      )
      .all(n) as ItemRowRaw[];
    return rows.map(toHit);
  } catch (err) {
    console.error(`[archive] gradeHistory failed: ${String(err)}`);
    return [];
  }
}

/** All archived notebook entries for a topic (every revision survives topic-replace). */
export function notebookHistory(topic?: string, n = 20): ArchiveHit[] {
  try {
    const rows = (
      topic
        ? db()
            .prepare(
              `SELECT stream, id, cycle_id, agent_id, ts, json FROM items
               WHERE stream = 'notebook' AND text LIKE ? ORDER BY ts DESC LIMIT ?`,
            )
            .all(`[${topic}%`, n)
        : db()
            .prepare(
              `SELECT stream, id, cycle_id, agent_id, ts, json FROM items
               WHERE stream = 'notebook' ORDER BY ts DESC LIMIT ?`,
            )
            .all(n)
    ) as ItemRowRaw[];
    return rows.map(toHit);
  } catch (err) {
    console.error(`[archive] notebookHistory failed: ${String(err)}`);
    return [];
  }
}

/* -------------------------------- Health ---------------------------------- */

export interface ArchiveStats {
  ok: boolean;
  dbFile: string;
  dbSizeBytes: number;
  rowCounts: Record<string, number>;
  totalRows: number;
  lastUpdatedAt: number | null;
  lastBackup: { file: string; at: number } | null;
  error?: string;
}

export function archiveStats(): ArchiveStats {
  const base: ArchiveStats = {
    ok: false,
    dbFile: DB_FILE,
    dbSizeBytes: 0,
    rowCounts: {},
    totalRows: 0,
    lastUpdatedAt: null,
    lastBackup: lastBackupInfo(),
  };
  try {
    const rows = db()
      .prepare(`SELECT stream, COUNT(*) AS n FROM items GROUP BY stream ORDER BY stream`)
      .all() as { stream: string; n: number }[];
    for (const r of rows) base.rowCounts[r.stream] = r.n;
    base.totalRows = rows.reduce((a, r) => a + r.n, 0);
    const last = db().prepare(`SELECT MAX(updated_at) AS m FROM items`).get() as { m: number | null };
    base.lastUpdatedAt = last.m;
    base.dbSizeBytes = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0;
    base.ok = true;
  } catch (err) {
    base.error = String(err);
  }
  return base;
}

const BACKUP_DIR = path.join(DATA_DIR, "backups");

function lastBackupInfo(): { file: string; at: number } | null {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const latest = files.at(-1);
    if (!latest) return null;
    return { file: latest, at: fs.statSync(path.join(BACKUP_DIR, latest)).mtimeMs };
  } catch {
    return null;
  }
}
