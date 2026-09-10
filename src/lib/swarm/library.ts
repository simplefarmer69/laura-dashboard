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

export async function libraryDigest(maxChars = 14_000): Promise<string> {
  const [docs, notebook, skills] = await Promise.all([libraryText(), notebookDigest(), skillsIndex()]);
  const text = [
    docs || "Library docs empty.",
    `## Skill index (full skill text is injected per role)\n${skills}`,
    `## Self-authored notebook (written by the swarm itself; newest last)\n${notebook}`,
  ].join("\n\n---\n\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[...library truncated]`;
}
