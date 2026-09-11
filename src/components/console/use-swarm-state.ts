"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmProvider, SwarmState } from "@/lib/types";
import type { MissionStatus } from "@/lib/mission-status";
import type { NotebookEntry } from "@/lib/swarm/notebook";
import type { HostInfo } from "@/components/console/viewer";

export interface ConsoleState extends SwarmState {
  mission: MissionStatus;
  evolution: {
    notebookCount: number;
    /** Newest first */
    notebook: NotebookEntry[];
    skills: { name: string; description: string; agents: string[] }[];
  };
  runtime: {
    cycleRunning: boolean;
    autopilot: boolean;
    llmProvider: LlmProvider;
    llmModel: string;
    x: { appKeys: boolean; accessKeys: boolean; ready: boolean; missing: string[] };
    /** Host facts captured where the swarm runs; absent on snapshots older than this field. */
    host?: HostInfo | null;
  };
  /** Present only on the public viewer deployment: snapshot provenance. */
  viewer?: { publishedAt: number } | null;
}

/** Consecutive failed polls; drives the retry backoff and the maintenance copy. */
export interface LinkStatus {
  /** Human copy for the maintenance notice; null while the link is healthy. */
  message: string | null;
  failures: number;
  /** When the last successful state arrived (ms); null before the first one. */
  lastGoodAt: number | null;
  /** Next automatic retry (ms since epoch); null while healthy. */
  nextRetryAt: number | null;
}

/**
 * Turn a fetch failure into maintenance copy. Visitors were seeing raw
 * "TimeoutError: signal timed out" (operator report 2026-09-11); the swarm
 * keeps running server-side while the console cannot reach it, so the notice
 * says that instead of surfacing exception text.
 */
function describeOutage(err: unknown, failures: number): string {
  const text = String(err);
  const timeout = /timed out|TimeoutError|AbortError/i.test(text);
  const http = text.match(/HTTP (\d{3})/)?.[1];
  const base = timeout
    ? "LAURA's host is slow to answer"
    : http && Number(http) >= 500
      ? "LAURA's host is restarting or under maintenance"
      : http
        ? `LAURA's host answered HTTP ${http}`
        : "The console cannot reach LAURA's host right now";
  const tail =
    failures >= 3
      ? " — the swarm keeps running in the background; the console reconnects automatically."
      : " — reconnecting.";
  return `${base}${tail}`;
}

/* The public snapshot is several MB and a cold host can take a while; 10 s
   was tripping "signal timed out" on healthy hosts. */
const FETCH_TIMEOUT_MS = 25_000;
const MAX_BACKOFF_MS = 120_000;

export function useSwarmState(pollMs = 15_000) {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [link, setLink] = useState<LinkStatus>({ message: null, failures: 0, lastGoodAt: null, nextRetryAt: null });
  const [loading, setLoading] = useState(true);
  const inflight = useRef(false);
  const failures = useRef(0);
  const holdUntil = useRef(0);

  const refresh = useCallback(async (opts: { force?: boolean } = {}) => {
    if (inflight.current) return;
    if (!opts.force && Date.now() < holdUntil.current) return;
    inflight.current = true;
    if (opts.force) setLoading(true);
    try {
      // Timeout so a hung request can't wedge `inflight` and block every later poll.
      const res = await fetch("/api/state", { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState((await res.json()) as ConsoleState);
      failures.current = 0;
      holdUntil.current = 0;
      setLink({ message: null, failures: 0, lastGoodAt: Date.now(), nextRetryAt: null });
    } catch (err) {
      failures.current += 1;
      /* Back off: 15s, 30s, 60s, 120s — a resting host is not hammered and the
         notice can show an honest "retrying in N s". */
      const backoff = Math.min(MAX_BACKOFF_MS, pollMs * 2 ** Math.min(3, failures.current - 1));
      holdUntil.current = Date.now() + backoff;
      setLink((prev) => ({
        message: describeOutage(err, failures.current),
        failures: failures.current,
        lastGoodAt: prev.lastGoodAt,
        nextRetryAt: holdUntil.current,
      }));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [pollMs]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const id = setInterval(() => void refresh(), pollMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { state, link, error: link.message, loading, refresh: () => refresh({ force: true }) };
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function postJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "POST" });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
