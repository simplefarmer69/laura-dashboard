import { promises as fs } from "node:fs";
import path from "node:path";
import { notebookDigest } from "@/lib/swarm/notebook";
import { skillsIndex } from "@/lib/swarm/skills";

/**
 * LAURA's library: durable context distilled from the build — who the operator
 * is, verified integration wire formats, operational learnings, and the
 * execution playbook. Lives in /library as ordered markdown (10-, 20-, …) so
 * the operator can edit it like code, and is injected into every agent prompt
 * and the public chat persona. Contains no secrets by policy.
 */

const LIBRARY_DIR = process.env.SWARM_LIBRARY_DIR ?? path.join(process.cwd(), "library");
const CACHE_TTL_MS = 60_000;
const SEP = "\n\n---\n\n";

interface LibraryDoc {
  file: string;
  text: string;
}

let cache: { at: number; docs: LibraryDoc[] } | null = null;

async function libraryDocs(): Promise<LibraryDoc[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.docs;
  let docs: LibraryDoc[] = [];
  try {
    const files = (await fs.readdir(LIBRARY_DIR)).filter((f) => f.endsWith(".md")).sort();
    docs = await Promise.all(
      files.map(async (f) => ({
        file: f,
        text: (await fs.readFile(path.join(LIBRARY_DIR, f), "utf8")).trim(),
      })),
    );
  } catch {
    docs = [];
  }
  cache = { at: Date.now(), docs };
  return docs;
}

export async function libraryText(): Promise<string> {
  return (await libraryDocs())
    .map((d) => d.text)
    .join(SEP)
    .trim();
}

/**
 * Docs section under a budget, allocated PER DOC instead of truncating the
 * concatenation. The old head-truncation meant that once the docs outgrew the
 * budget, every doc past the cut point (30-integrations onward, including any
 * newly added doc) was silently absent from every prompt. Now every doc keeps
 * at least its head (front-load the load-bearing summary in each doc), and
 * docs earlier in the numbered order absorb whatever budget remains, so the
 * operator/project docs keep their depth.
 */
function docsSection(docs: LibraryDoc[], budget: number): string {
  if (docs.length === 0) return "Library docs empty.";
  const sepTotal = SEP.length * (docs.length - 1);
  const total = docs.reduce((s, d) => s + d.text.length, 0);
  if (total + sepTotal <= budget) return docs.map((d) => d.text).join(SEP);
  const usable = Math.max(0, budget - sepTotal);
  const floor = Math.min(1_000, Math.floor(usable / docs.length));
  const alloc = docs.map((d) => Math.min(d.text.length, floor));
  let leftover = usable - alloc.reduce((s, n) => s + n, 0);
  for (let i = 0; i < docs.length && leftover > 0; i++) {
    const grant = Math.min(docs[i].text.length - alloc[i], leftover);
    alloc[i] += grant;
    leftover -= grant;
  }
  return docs
    .map((d, i) => {
      if (d.text.length <= alloc[i]) return d.text;
      const marker = `\n[...trimmed; full doc: library/${d.file}]`;
      return `${d.text.slice(0, Math.max(200, alloc[i] - marker.length))}${marker}`;
    })
    .join(SEP);
}

/**
 * Per-section budgets instead of one tail truncation: the skill index and the
 * self-authored notebook always survive, and the docs section is budgeted per
 * doc (see docsSection) so every library doc reaches every prompt with at
 * least its head. Default raised 14k → 22k when per-doc budgeting landed, so
 * the operator and project docs keep the same depth they had while the other
 * docs gain their heads; raised 22k → 23k when 25-stonkbrokers-official.md
 * joined, covering its 1k floor so no existing doc lost depth; raised
 * 23k → 26k when Sage's collective intelligence ledger joined as its own
 * budgeted section (the 1k per-doc floor would have trimmed the ledger to its
 * header, and reaching every agent whole is the ledger's entire job).
 */
const LEDGER_FILE = "65-collective-intelligence.md";
const LEDGER_BUDGET = 3_000;

export async function libraryDigest(maxChars = 26_000): Promise<string> {
  const [allDocs, notebook, skills] = await Promise.all([libraryDocs(), notebookDigest(), skillsIndex()]);
  /* The ledger gets a dedicated head-kept section (newest entries lead the
     doc by construction); it is excluded from the shared docs budget. */
  const ledger = allDocs.find((d) => d.file === LEDGER_FILE);
  const docs = allDocs.filter((d) => d.file !== LEDGER_FILE);
  const ledgerText = ledger
    ? ledger.text.length <= LEDGER_BUDGET
      ? ledger.text
      : `${ledger.text.slice(0, LEDGER_BUDGET)}\n[...ledger trimmed; full doc: library/${LEDGER_FILE}]`
    : null;
  const ledgerSec = ledgerText
    ? `## Collective intelligence ledger (Sage's shared context; apply it)\n${ledgerText}`
    : null;
  /* Notebook: keep the TAIL (newest entries last is the file's order). */
  const notebookBudget = 4_500;
  const notebookText =
    notebook.length <= notebookBudget
      ? notebook
      : `[...older notebook entries elided; the archive keeps them all]\n${notebook.slice(-notebookBudget)}`;
  const skillsBudget = 1_500;
  const skillsText =
    skills.length <= skillsBudget ? skills : `${skills.slice(0, skillsBudget)}\n[...skill index truncated]`;
  const notebookSec = `## Self-authored notebook (written by the swarm itself; newest last)\n${notebookText}`;
  const skillsSec = `## Skill index (full skill text is injected per role)\n${skillsText}`;
  const fixedLen =
    notebookSec.length + skillsSec.length + (ledgerSec ? ledgerSec.length + SEP.length : 0) + SEP.length * 2;
  const docsBudget = Math.max(3_000, maxChars - fixedLen);
  const docsSec = docsSection(docs, docsBudget);
  return [docsSec, ...(ledgerSec ? [ledgerSec] : []), skillsSec, notebookSec].join(SEP);
}

/* --------------------------- Self-editing (sage) ---------------------------- */

/**
 * Docs Sage may never write: the operator's own directives and the project
 * ground truth. Protection is code-level, mirroring how writeSkill constrains
 * the coach; the deny decision never depends on the model behaving.
 */
const PROTECTED_DOCS = new Set(["10-operator.md", "20-project.md"]);
/** Hard cap on library docs so self-editing can grow the shelf but never flood
 * the per-doc digest budgets (11 operator-authored docs + Sage's ledger ship
 * in the repo; 14 leaves modest self-edit headroom). */
const MAX_LIBRARY_FILES = 14;
/** Numbered kebab-case markdown names only; no separators means no traversal. */
const DOC_FILE_RE = /^[1-9][0-9]-[a-z0-9][a-z0-9-]{1,58}\.md$/;

export interface LibraryDocEdit {
  file: string;
  body: string;
}

/**
 * Sage's code-free lever on shared context: create or replace one library doc.
 * Constrained by construction, same posture as the coach's writeSkill: the
 * filename must match the numbered-doc pattern (no traversal possible), writes
 * never leave /library, the operator's directive docs are denied outright, and
 * the doc count is capped. Code, caps, guards and everything outside the
 * library stay out of reach.
 */
export async function writeLibraryDoc(edit: LibraryDocEdit): Promise<{ file: string; created: boolean }> {
  const file = edit.file.trim().toLowerCase();
  if (!DOC_FILE_RE.test(file)) {
    throw new Error(`library doc name "${edit.file}" must be a numbered kebab-case .md name like 65-collective-intelligence.md`);
  }
  if (PROTECTED_DOCS.has(file)) {
    throw new Error(`"${file}" carries operator directives and is protected from agent edits`);
  }
  const target = path.resolve(LIBRARY_DIR, file);
  if (path.dirname(target) !== path.resolve(LIBRARY_DIR)) throw new Error("library doc path escaped the library dir");

  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  const existing = (await fs.readdir(LIBRARY_DIR)).filter((f) => f.endsWith(".md"));
  const created = !existing.includes(file);
  if (created && existing.length >= MAX_LIBRARY_FILES) {
    throw new Error(
      `library doc cap reached (${MAX_LIBRARY_FILES} files): update an existing doc instead of creating "${file}"`,
    );
  }
  const body = edit.body.trim();
  if (body.length < 80) throw new Error("library doc body too short to be useful shared context");
  await fs.writeFile(target, `${body}\n`, "utf8");
  cache = null; // next libraryDocs() re-reads from disk
  return { file, created };
}

/** Full current text of one library doc, empty string when it does not exist yet. */
export async function libraryDocText(file: string): Promise<string> {
  const doc = (await libraryDocs()).find((d) => d.file === file);
  return doc?.text ?? "";
}

/** One line per doc with sizes and protection state, for Sage's curate pass. */
export async function libraryFileIndex(): Promise<string> {
  const docs = await libraryDocs();
  if (docs.length === 0) return "Library empty.";
  return docs
    .map((d) => `- ${d.file}: ${d.text.length.toLocaleString()} chars${PROTECTED_DOCS.has(d.file) ? " [PROTECTED: operator-owned, no agent edits]" : ""}`)
    .join("\n");
}
