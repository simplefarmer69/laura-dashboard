"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Eye } from "lucide-react";

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

/** The public header strip: what this is, where it runs, and how fresh the data is. */
export function ViewerBanner({ publishedAt, host }: { publishedAt: number | null; host?: HostInfo | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const stale = publishedAt !== null && now - publishedAt > STALE_AFTER_MS;
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
            host: {describeHost(host)} · continuous cycles
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          {publishedAt === null ? (
            "waiting for the first snapshot…"
          ) : (
            <>
              <span className={`size-1.5 rounded-full ${stale ? "bg-[var(--sb-gold)]" : "bg-[var(--sb-green)] sb-pulse"}`} />
              updated {ago(publishedAt, now)}
              {stale && <span className="text-[var(--sb-gold)]/90"> · LAURA&apos;s host may be resting</span>}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
