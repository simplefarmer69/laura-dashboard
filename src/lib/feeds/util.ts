/**
 * Shared plumbing for the live data feeds that LAURA's swarm (and the
 * console UI) consume: module level caching with a last good fallback so an
 * upstream hiccup never serves an empty payload, plus a bounded JSON fetch.
 *
 * All feeds are read only and use public, unkeyed endpoints  -  safe to run in
 * viewer mode and safe to expose at laura.stonkbrokers.io/api/feeds/*.
 */

type CacheEntry<T> = { at: number; data: T };

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Serve `key` from cache while younger than `ttlMs`; otherwise reload.
 * A failed reload serves the last good value (marked stale) instead of
 * erroring  -  the "never publish an empty snapshot" rule.
 * Concurrent callers share one inflight load.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<{ data: T; stale: boolean; at: number }> {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return { data: hit.data, stale: false, at: hit.at };

  let job = inflight.get(key) as Promise<T> | undefined;
  if (!job) {
    job = load().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  try {
    const data = await job;
    const at = Date.now();
    store.set(key, { at, data });
    return { data, stale: false, at };
  } catch (err) {
    if (hit) return { data: hit.data, stale: true, at: hit.at };
    throw err;
  }
}

/** GET a JSON document with a hard timeout and no framework caching. */
export async function getJson<T>(url: string, timeoutMs = 8_000): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Standard JSON response with short CDN caching for feed routes. */
export function feedResponse(body: unknown, sMaxAge = 10): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=60`,
    },
  });
}

export function feedError(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}
