/**
 * Official site surface — LAURA's live link to everything StonkBrokers hosts.
 *
 * The website publishes a machine-readable surface for agents:
 *  - /llms-full.txt    canonical product context + interpretation rules
 *  - /ecosystem.json   surfaces (Exchange, Stonklauncher, Special Projects,
 *                      Anvil AMM, Leverage Machine, Broker Tools) with status
 *  - /sitemap.xml      every public page; /launches/sitemap.xml every launch
 *
 * This module reads them on a slow cache and hands the swarm (a) a digest that
 * keeps product names, statuses and rules in sync with the site itself, and
 * (b) a rotating slice of site pages for the browser worker, so over a day
 * LAURA has re-read every page the team ships. The library's curated notes
 * stay the long-term memory; this is the live truth on top of them.
 *
 * Read-only, fail-soft: any failure returns the last good value or nothing.
 */

export interface SiteSurface {
  name: string;
  url: string;
  status?: string;
  description?: string;
}

export interface SiteContext {
  fetchedAt: number;
  llmsFull: string;
  surfaces: SiteSurface[];
  pages: string[];
  launchPages: number;
  canonicalUrl: string;
}

const SITE_ORIGIN = (process.env.STONKBROKERS_SITE ?? "https://stonkbrokers.io").replace(/\/$/, "");
const CACHE_TTL_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = "Mozilla/5.0 laura-swarm/1.0 (read-only; site surface sync)";
const MAX_LLMS_CHARS = 4_000;

declare global {
  var __lauraSiteContext: SiteContext | null | undefined;
}

async function text(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

function parseSurfaces(json: string): SiteSurface[] {
  try {
    const parsed = JSON.parse(json) as { surfaces?: unknown };
    if (!Array.isArray(parsed.surfaces)) return [];
    return parsed.surfaces
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .map((s) => ({
        name: String(s.name ?? ""),
        url: String(s.url ?? ""),
        status: typeof s.status === "string" ? s.status : undefined,
        description: typeof s.description === "string" ? s.description : undefined,
      }))
      .filter((s) => s.name && s.url);
  } catch {
    return [];
  }
}

/** Live site context, cached 6 h; the previous value survives a failed refresh. */
export async function fetchSiteContext(): Promise<SiteContext | null> {
  const cached = globalThis.__lauraSiteContext ?? null;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const [llms, eco, sitemap, launches] = await Promise.allSettled([
    text(`${SITE_ORIGIN}/llms-full.txt`),
    text(`${SITE_ORIGIN}/ecosystem.json`),
    text(`${SITE_ORIGIN}/sitemap.xml`),
    text(`${SITE_ORIGIN}/launches/sitemap.xml`),
  ]);
  if (llms.status === "rejected" && eco.status === "rejected" && sitemap.status === "rejected") return cached;
  const next: SiteContext = {
    fetchedAt: Date.now(),
    llmsFull: llms.status === "fulfilled" ? llms.value.trim() : cached?.llmsFull ?? "",
    surfaces: eco.status === "fulfilled" ? parseSurfaces(eco.value) : cached?.surfaces ?? [],
    pages: sitemap.status === "fulfilled" ? sitemapLocs(sitemap.value) : cached?.pages ?? [],
    launchPages: launches.status === "fulfilled" ? sitemapLocs(launches.value).filter((u) => /\/safe-launch\/token\//.test(u)).length : cached?.launchPages ?? 0,
    canonicalUrl: SITE_ORIGIN,
  };
  globalThis.__lauraSiteContext = next;
  return next;
}

/**
 * Prompt block: the site's own words about what it ships and how to talk
 * about it. Comes from the team's published files, so it is presented as the
 * authoritative product reference, not as untrusted community input.
 */
export function siteDigest(ctx: SiteContext | null): string {
  if (!ctx) return "";
  const lines = [
    `OFFICIAL SITE SURFACE (live from ${ctx.canonicalUrl} — llms-full.txt, ecosystem.json and the sitemaps; the ground truth for product names, launch status and wording rules; ${ctx.pages.length} public pages, ${ctx.launchPages} live launch pages):`,
  ];
  if (ctx.surfaces.length > 0) {
    lines.push("Surfaces:");
    for (const s of ctx.surfaces) {
      lines.push(`- ${s.name}${s.status ? ` [${s.status.replace(/_/g, " ")}]` : ""} — ${s.url}${s.description ? ` — ${s.description.slice(0, 160)}` : ""}`);
    }
  }
  if (ctx.llmsFull) lines.push(ctx.llmsFull.slice(0, MAX_LLMS_CHARS));
  return lines.join("\n");
}

/**
 * Which site pages the browser worker reads this cycle. Rotates through the
 * main sitemap by cycle count so every public page gets re-read about daily;
 * launch pages are skipped here (the launcher feeds cover them live).
 */
export function sitePagesForCycle(ctx: SiteContext | null, cycleIndex: number, count = 2): string[] {
  if (!ctx || ctx.pages.length === 0 || count <= 0) return [];
  const pages = ctx.pages.filter((u) => !/\/safe-launch\/token\//.test(u));
  if (pages.length === 0) return [];
  const start = (Math.max(0, cycleIndex) * count) % pages.length;
  const picks: string[] = [];
  for (let i = 0; i < Math.min(count, pages.length); i += 1) picks.push(pages[(start + i) % pages.length]);
  return picks;
}
