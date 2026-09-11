import { promises as fs } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { redactSecrets } from "@/lib/store";
import { browserEngine, type BrowserEngine } from "@/lib/swarm/browser";

/**
 * Operator co-pilot surface for a self-hosted LAURA (PC daemon / Railway).
 *
 * Purpose: let the Cursor agent inspect and steer the daemon remotely with a
 * narrow, token-gated API instead of a shell — logs, release info, and two
 * request flags (update, restart) the daemon scripts honour at a quiet moment.
 * No command execution, no state mutation beyond those flags.
 *
 * Every response passes through redactSecrets; the token itself matches the
 * SENSITIVE_ENV_NAME pattern so it is scrubbed too. With no OPERATOR_TOKEN set
 * the whole surface answers 404 — an unconfigured host exposes nothing.
 */

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const OPS_DIR = path.join(DATA_DIR, "ops");

export const UPDATE_FLAG = path.join(OPS_DIR, "update.requested");
export const RESTART_FLAG = path.join(OPS_DIR, "restart.requested");

export function opsEnabled(): boolean {
  return (process.env.OPERATOR_TOKEN ?? "").length >= 24;
}

/** Constant-time bearer check; false whenever the surface is disabled. */
export function authorized(req: Request): boolean {
  const expected = process.env.OPERATOR_TOKEN ?? "";
  if (expected.length < 24) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

export async function requestFlag(flag: string, note: string): Promise<void> {
  await fs.mkdir(OPS_DIR, { recursive: true });
  await fs.writeFile(flag, `${new Date().toISOString()} ${note}\n`, "utf8");
}

export async function flagPending(flag: string): Promise<boolean> {
  try {
    await fs.access(flag);
    return true;
  } catch {
    return false;
  }
}

export async function clearFlag(flag: string): Promise<void> {
  await fs.rm(flag, { force: true });
}

/** Last N lines of a data-dir log, secrets scrubbed; "" when the file is absent. */
export async function tailLog(name: string, lines: number): Promise<string> {
  const safe = path.basename(name);
  const file = path.join(DATA_DIR, safe);
  try {
    const stat = await fs.stat(file);
    const handle = await fs.open(file, "r");
    try {
      /* Read at most the last 256 KB; logs are line-oriented so that covers far more than any sane tail. */
      const span = Math.min(stat.size, 256 * 1024);
      const buf = Buffer.alloc(span);
      await handle.read(buf, 0, span, stat.size - span);
      const text = buf.toString("utf8");
      return redactSecrets(text.split("\n").slice(-Math.max(1, Math.min(lines, 2000))).join("\n"));
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/** Release marker written by the daemon's updater into the running release dir. */
export async function releaseInfo(): Promise<{ sha: string | null; builtAt: string | null }> {
  try {
    const text = await fs.readFile(path.join(process.cwd(), ".release"), "utf8");
    const [sha, builtAt] = text.trim().split(/\s+/);
    return { sha: sha ?? null, builtAt: builtAt ?? null };
  } catch {
    return { sha: process.env.LAURA_RELEASE ?? null, builtAt: null };
  }
}

/** Where and how this LAURA process runs — shown on the console and the public viewer. */
export async function hostInfo(): Promise<{
  mode: "daemon" | "server" | "dev" | "viewer";
  release: string | null;
  builtAt: string | null;
  uptimeSec: number;
  browser: BrowserEngine;
}> {
  const viewer = process.env.VIEWER_MODE === "1" || process.env.NEXT_PUBLIC_VIEWER_MODE === "1";
  const mode = viewer ? "viewer" : process.env.LAURA_DAEMON === "1" ? "daemon" : process.env.NODE_ENV === "production" ? "server" : "dev";
  const rel = await releaseInfo();
  return { mode, release: rel.sha ? rel.sha.slice(0, 7) : null, builtAt: rel.builtAt, uptimeSec: Math.round(process.uptime()), browser: browserEngine() };
}
