"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmProvider, SwarmState } from "@/lib/types";
import type { MissionStatus } from "@/lib/mission-status";

export interface ConsoleState extends SwarmState {
  mission: MissionStatus;
  runtime: {
    cycleRunning: boolean;
    autopilot: boolean;
    llmProvider: LlmProvider;
    llmModel: string;
    x: { appKeys: boolean; accessKeys: boolean; ready: boolean; missing: string[] };
  };
}

export function useSwarmState(pollMs = 15_000) {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      // Timeout so a hung request can't wedge `inflight` and block every later poll.
      const res = await fetch("/api/state", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState((await res.json()) as ConsoleState);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const id = setInterval(() => void refresh(), pollMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { state, error, loading, refresh };
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
