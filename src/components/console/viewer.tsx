"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
import type { RuntimeActivity } from "@/lib/swarm/scheduler";

/**
 * Client-side face of the public viewer (laura.stonkbrokers.io). Inlined at
 * build time; absent on the operator's local console, which stays fully
 * interactive. The real enforcement is server-side (every mutation route
 * returns 403 in viewer mode) — this layer only makes the read-only state
 * visible and honest.
 */
export const VIEWER_MODE = process.env.NEXT_PUBLIC_VIEWER_MODE === "1";

/**
 * Renders a panel's controls disabled in viewer mode. A disabled <fieldset>
 * natively disables every button, input, textarea and select inside it (the
 * whole console uses native controls), and `display: contents` keeps it out
 * of the layout. Dialog triggers are buttons too, so portal-rendered dialog
 * actions are unreachable as well.
 */
export function ViewerShield({ children }: { children: ReactNode }) {
  if (!VIEWER_MODE) return <>{children}</>;
  return (
    <fieldset disabled aria-label="View-only panel" className="contents">
      {children}
    </fieldset>
  );
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STALE_AFTER_MS = 12 * 60_000;

/** Where the runtime that produced this data is living, as the state route reports it. */
export interface HostInfo {
  mode: "daemon" | "server" | "dev" | "viewer";
  release: string | null;
  builtAt: string | null;
  uptimeSec: number;
  browser: "chromium" | "fetch";
}

const HOST_MODE_LABEL: Record<HostInfo["mode"], string> = {
  daemon: "PC daemon",
  server: "server",
  dev: "dev server",
  viewer: "viewer",
};

function uptime(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))}m`;
  const h = Math.floor(sec / 3600);
  if (h < 48) return `${h}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** One-line description of the host, shared by the public banner and the operator header. */
export function describeHost(host: HostInfo): string {
  const parts = [HOST_MODE_LABEL[host.mode]];
  if (host.release) parts.push(host.release.slice(0, 7));
  parts.push(`up ${uptime(host.uptimeSec)}`);
  parts.push(host.browser === "chromium" ? "browser: chromium" : "browser: fetch");
  return parts.join(" · ");
}

function clockUtc(ts: number): string {
  return `${new Date(ts).toUTCString().slice(17, 22)} UTC`;
}

function minutesUntil(ts: number, now: number): string {
  const m = Math.ceil((ts - now) / 60_000);
  if (m <= 0) return "now";
  if (m < 60) return `~${m}m`;
  return `~${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Plain statement of what LAURA is doing, from the runtime's own signal.
 * `asOf` is when that signal was captured (the snapshot's publish time on
 * the public site; the poll time on the local console), so countdowns are
 * computed against real wall-clock and never claim a cycle "in progress"
 * from a snapshot that is itself out of date.
 */
export function describeActivity(activity: RuntimeActivity, now: number): { text: string; tone: "live" | "quiet" | "warn" } {
  switch (activity.phase) {
    case "cycle":
      return {
        text: `cycle in progress${activity.since ? ` since ${clockUtc(activity.since)}` : ""}`,
        tone: "live",
      };
    case "forum":
      return {
        text: `Cafe Bar round in progress${activity.since ? ` since ${clockUtc(activity.since)}` : ""}`,
        tone: "live",
      };
    case "between":
      return {
        text: activity.nextCycleAt ? `between cycles · next starts ${minutesUntil(activity.nextCycleAt, now)}` : "between cycles",
        tone: "quiet",
      };
    case "paused":
      return {
        text: `cycles paused: ${activity.note ?? "budget"}${activity.nextCycleAt ? ` · resumes ${minutesUntil(activity.nextCycleAt, now)}` : ""}`,
        tone: "warn",
      };
    case "off":
      return { text: "autopilot off on the host", tone: "warn" };
    default: {
      const exhaustive: never = activity.phase;
      return exhaustive;
    }
  }
}

const ACTIVITY_TONE: Record<"live" | "quiet" | "warn", string> = {
  live: "text-[var(--sb-green)]",
  quiet: "text-muted-foreground",
  warn: "text-[var(--sb-gold)]/90",
};

/** The public header strip: what this is, where it runs, and how fresh the data is. */
export function ViewerBanner({
  publishedAt,
  host,
  activity,
}: {
  publishedAt: number | null;
  host?: HostInfo | null;
  activity?: RuntimeActivity | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const stale = publishedAt !== null && now - publishedAt > STALE_AFTER_MS;
  /* The phase is only trustworthy while the snapshot is fresh; a stale one
     says how old it is and nothing about what LAURA is doing right now. */
  const phase = activity && !stale ? describeActivity(activity, now) : null;
  return (
    <div className="border-b border-primary/25 bg-primary/10">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 sb-ticker text-[11px] sm:px-6">
        <span className="flex items-center gap-1.5 text-primary">
          <Eye className="size-3.5" /> LIVE VIEW
        </span>
        <span className="text-muted-foreground">
          watching LAURA work; admin controls are local-only
        </span>
        {host && (
          <span className="hidden font-mono text-muted-foreground/90 sm:inline" title={host.builtAt ? `built ${host.builtAt}` : undefined}>
            host: {describeHost(host)}
          </span>
        )}
        {phase && <span className={`font-mono ${ACTIVITY_TONE[phase.tone]}`}>{phase.text}</span>}
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          {publishedAt === null ? (
            "waiting for the first snapshot…"
          ) : (
            <>
              <span className={`size-1.5 rounded-full ${stale ? "bg-[var(--sb-gold)]" : "bg-[var(--sb-green)] sb-pulse"}`} />
              updated {ago(publishedAt, now)}
              {stale && (
                <span className="text-[var(--sb-gold)]/90"> · no fresh snapshot for {ago(publishedAt, now).replace(" ago", "")}; showing the last one</span>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
