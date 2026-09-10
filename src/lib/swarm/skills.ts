import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentId } from "@/lib/types";

/**
 * LAURA's skill system, modelled on Cursor's agent skills: each skill is a
 * markdown file in /library/skills with YAML frontmatter (name, description,
 * agents). Skills are operating procedures distilled from observed failures
 * and wins; the orchestrator injects each agent's skills into its prompts,
 * so a skill edit changes behavior on the next cycle without a code change.
 */

export interface Skill {
  name: string;
  description: string;
  /** Agent ids this skill is injected for; "all" targets every agent. */
  agents: string[];
  body: string;
}

const SKILLS_DIR = process.env.SWARM_LIBRARY_DIR
  ? path.join(process.env.SWARM_LIBRARY_DIR, "skills")
  : path.join(process.cwd(), "library", "skills");
const CACHE_TTL_MS = 60_000;

let cache: { at: number; skills: Skill[] } | null = null;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

export async function loadSkills(): Promise<Skill[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.skills;
  let skills: Skill[] = [];
  try {
    const files = (await fs.readdir(SKILLS_DIR)).filter((f) => f.endsWith(".md")).sort();
    skills = await Promise.all(
      files.map(async (f) => {
        const raw = await fs.readFile(path.join(SKILLS_DIR, f), "utf8");
        const { meta, body } = parseFrontmatter(raw);
        return {
          name: meta.name ?? f.replace(/\.md$/, ""),
          description: meta.description ?? "",
          agents: (meta.agents ?? "all").split(",").map((a) => a.trim().toLowerCase()),
          body,
        };
      }),
    );
  } catch {
    skills = [];
  }
  cache = { at: Date.now(), skills };
  return skills;
}

/** Full text of the skills that apply to one agent, ready for prompt injection. */
export async function skillsForAgent(agentId: AgentId): Promise<string> {
  const skills = (await loadSkills()).filter(
    (s) => s.agents.includes("all") || s.agents.includes(agentId),
  );
  if (skills.length === 0) return "No skills on file for this role yet.";
  return skills.map((s) => `### Skill: ${s.name}\n${s.body}`).join("\n\n");
}

/** One-line-per-skill index so every agent knows what the swarm knows. */
export async function skillsIndex(): Promise<string> {
  const skills = await loadSkills();
  if (skills.length === 0) return "No skills recorded yet.";
  return skills.map((s) => `- ${s.name} (${s.agents.join(", ")}): ${s.description}`).join("\n");
}

/* ------------------------- Self-editing (coach) ---------------------------- */

/** Hard cap on skill files so self-editing can grow the library but never flood it. */
const MAX_SKILL_FILES = 16;

export interface SkillEdit {
  name: string;
  description: string;
  agents: string[];
  body: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * The coach's code-free lever on operating procedures: create or replace one
 * skill file. Constrained by construction — the filename is a slug of the
 * name (no traversal possible), writes never leave /library/skills, the file
 * count is capped, and frontmatter values are stripped of newlines. Code,
 * caps and everything outside the skills dir stay out of reach.
 */
export async function writeSkill(edit: SkillEdit): Promise<{ file: string; created: boolean }> {
  const slug = slugify(edit.name);
  if (!slug) throw new Error(`skill name "${edit.name}" produced an empty filename slug`);
  const file = `${slug}.md`;
  const target = path.resolve(SKILLS_DIR, file);
  if (path.dirname(target) !== path.resolve(SKILLS_DIR)) throw new Error("skill path escaped the skills dir");

  await fs.mkdir(SKILLS_DIR, { recursive: true });
  const existing = (await fs.readdir(SKILLS_DIR)).filter((f) => f.endsWith(".md"));
  const created = !existing.includes(file);
  if (created && existing.length >= MAX_SKILL_FILES) {
    throw new Error(
      `skill cap reached (${MAX_SKILL_FILES} files): update an existing skill instead of creating "${file}"`,
    );
  }

  const line = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const agents = edit.agents.map((a) => line(a).toLowerCase()).filter(Boolean);
  const content = [
    "---",
    `name: ${line(edit.name)}`,
    `description: ${line(edit.description)}`,
    `agents: ${agents.join(", ") || "all"}`,
    "---",
    "",
    edit.body.trim(),
    "",
  ].join("\n");
  await fs.writeFile(target, content, "utf8");
  cache = null; // next loadSkills() re-reads from disk
  return { file, created };
}
