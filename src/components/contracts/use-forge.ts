"use client";
import { useEffect, useState } from "react";
import type { ForgeProject } from "@/lib/types";

export type PublicProject = Omit<ForgeProject, "bytecode">;

interface ForgeFeed {
  ok: boolean;
  projects: PublicProject[];
}

/** LAURA's contracts from the public feed (the snapshot on the public site, live state on the swarm host). */
export function useForgeProjects(): { projects: PublicProject[] | null; error: string | null; reload: () => void } {
  const [projects, setProjects] = useState<PublicProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/forge", { cache: "no-store" });
        if (!res.ok) throw new Error(`feed answered ${res.status}`);
        const json = (await res.json()) as ForgeFeed;
        if (!cancelled) {
          setProjects(json.projects ?? []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { projects, error, reload: () => setTick((t) => t + 1) };
}
