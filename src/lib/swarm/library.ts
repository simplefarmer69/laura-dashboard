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

let cache: { at: number; text: string } | null = null;

export async function libraryText(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.text;
  try {
    const files = (await fs.readdir(LIBRARY_DIR)).filter((f) => f.endsWith(".md")).sort();
    const parts = await Promise.all(files.map((f) => fs.readFile(path.join(LIBRARY_DIR, f), "utf8")));
    const text = parts.join("\n\n---\n\n").trim();
    cache = { at: Date.now(), text };
    return text;
  } catch {
    return "";
  }
}

/**
 * Per-section budgets instead of one tail truncation. The old version sliced
 * the assembled text from the end — and because the curated docs alone exceed
 * the cap, the skill index and the ENTIRE self-authored notebook (the swarm's
 * own accumulated memory) were silently cut from every prompt. Now the
 * notebook and skill index always survive; the docs absorb the truncation.
 */
export async function libraryDigest(maxChars = 14_000): Promise<string> {
  const [docs, notebook, skills] = await Promise.all([libraryText(), notebookDigest(), skillsIndex()]);
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
  const sep = "\n\n---\n\n";
  const docsBudget = Math.max(3_000, maxChars - notebookSec.length - skillsSec.length - sep.length * 2);
  const docsAll = docs || "Library docs empty.";
  const docsSec =
    docsAll.length <= docsBudget
      ? docsAll
      : `${docsAll.slice(0, docsBudget)}\n[...library docs truncated at ${docsBudget} chars]`;
  return [docsSec, skillsSec, notebookSec].join(sep);
}
