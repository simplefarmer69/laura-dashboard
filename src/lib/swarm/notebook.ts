import { promises as fs } from "node:fs";
import path from "node:path";
import { newId } from "@/lib/store";

/**
 * LAURA's notebook: durable, self-authored storage. The coach writes entries
 * during cycles (reference knowledge, verified mechanics, operator context) —
 * distinct from lessons, which are tactical. Topics act as keys: writing an
 * existing topic replaces the entry, so knowledge stays current instead of
 * accumulating stale duplicates. Lives in the data dir (git-ignored) because
 * it is runtime state, not code.
 */

export interface NotebookEntry {
  id: string;
  ts: number;
  cycleId: string;
  topic: string;
  text: string;
}

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const NOTEBOOK_FILE = path.join(DATA_DIR, "notebook.json");
const MAX_ENTRIES = 150;

let writeChain: Promise<unknown> = Promise.resolve();

export async function loadNotebook(): Promise<NotebookEntry[]> {
  try {
    return JSON.parse(await fs.readFile(NOTEBOOK_FILE, "utf8")) as NotebookEntry[];
  } catch {
    return [];
  }
}

async function saveNotebook(entries: NotebookEntry[]): Promise<void> {
  const run = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(NOTEBOOK_FILE, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), "utf8");
  };
  writeChain = writeChain.then(run, run);
  await writeChain;
}

export interface RecordedNote {
  entry: NotebookEntry;
  replaced: boolean;
}

/** Records notes; an existing topic (case-insensitive) is replaced, not duplicated. */
export async function recordNotes(
  cycleId: string,
  notes: { topic: string; text: string }[],
): Promise<RecordedNote[]> {
  if (notes.length === 0) return [];
  const entries = await loadNotebook();
  const recorded: RecordedNote[] = [];
  for (const note of notes) {
    const topic = note.topic.trim();
    const idx = entries.findIndex((e) => e.topic.toLowerCase() === topic.toLowerCase());
    const entry: NotebookEntry = {
      id: newId("note"),
      ts: Date.now(),
      cycleId,
      topic,
      text: note.text.trim(),
    };
    if (idx >= 0) {
      entries[idx] = entry;
      recorded.push({ entry, replaced: true });
    } else {
      entries.push(entry);
      recorded.push({ entry, replaced: false });
    }
  }
  await saveNotebook(entries);
  return recorded;
}

export async function notebookDigest(limit = 40): Promise<string> {
  const entries = (await loadNotebook()).slice(-limit);
  if (entries.length === 0) return "Notebook empty — record durable knowledge as you learn it.";
  return entries.map((e) => `- [${e.topic}] ${e.text}`).join("\n");
}
