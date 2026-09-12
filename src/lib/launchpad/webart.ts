import sharp from "sharp";
import { chromiumExecutablePath, loadPlaywright, type PlaywrightLike } from "@/lib/swarm/browser";

/**
 * Web-sourced token art (operator directive 2026-09-12: "mint is using images
 * that are identical for every [token] — allow it to get images using chromium
 * for the tokens too"). Mint writes an imageQuery per launch; this module
 * finds a real image for it and processes it under the launcher's 48KB cap.
 *
 * Two engines, same shape as the browser worker:
 *  - Chromium (Playwright, SWARM_BROWSER=1): renders a DuckDuckGo image search
 *    (strict safe search) and harvests result thumbnails. Every thumbnail is
 *    served through DDG's own proxy host, so downloads never touch arbitrary
 *    origins.
 *  - Openverse REST API otherwise: CC-licensed images, thumbnails proxied
 *    through api.openverse.org. No key needed.
 *
 * Safety posture matches browser.ts: read-only, fixed search hosts, image
 * bytes are only ever handed to sharp (decoded, resized, re-encoded — nothing
 * from the source file survives into the output except pixels), hard caps on
 * download size and per-candidate timeouts. Failures return null so the
 * procedural renderer in art.ts stays the fallback for every launch.
 */

/** Downloads may only come from these proxy hosts (never the original origin). */
const ALLOWED_IMAGE_HOSTS = ["external-content.duckduckgo.com", "api.openverse.org"];

const SEARCH_TIMEOUT_MS = 20_000;
const RESULTS_SETTLE_MS = 3_500;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 6 * 1024 * 1024;
const MIN_SOURCE_PX = 160;
const MAX_ASPECT = 2.6;
const MAX_CANDIDATE_TRIES = 6;
const LOGO_MAX_BYTES = 48 * 1024;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* FNV-1a, duplicated from art.ts on purpose: art.ts imports this module, so
   importing back would create a cycle. */
function seedHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function imageHostAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_IMAGE_HOSTS.includes(host);
  } catch {
    return false;
  }
}

/** Chromium engine: render DDG image search, collect proxied result thumbnails. */
async function searchWithChromium(pw: PlaywrightLike, query: string): Promise<string[]> {
  const browser = await pw.chromium.launch({ headless: true, executablePath: chromiumExecutablePath() });
  try {
    const context = await browser.newContext({ userAgent: UA, javaScriptEnabled: true });
    try {
      const page = await context.newPage();
      try {
        /* kp=1 = strict safe search; iax/ia land directly on the images tab. */
        const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images&kp=1`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
        await page.waitForTimeout(RESULTS_SETTLE_MS);
        const srcs = await page.evaluate<string[]>(() =>
          Array.from(document.images)
            .map((img) => img.src)
            .filter(Boolean),
        );
        return srcs.filter((s) => imageHostAllowed(s));
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Fetch engine: Openverse API (CC-licensed), thumbnails proxied by the API
 * host. Openverse matches near-literally, so a long Mint phrase ("red tape
 * wrapped around documents") often returns zero — when that happens the
 * search retries with the first three words before giving up.
 */
async function searchWithOpenverse(query: string): Promise<string[]> {
  const attempts = [query];
  const short = query.split(/\s+/).slice(0, 3).join(" ");
  if (short !== query) attempts.push(short);
  for (const q of attempts) {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20&mature=false`;
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Openverse HTTP ${res.status}`);
    const json = (await res.json()) as { results?: Array<{ thumbnail?: string }> };
    const thumbs = (json.results ?? [])
      .map((r) => r.thumbnail ?? "")
      .filter((u) => imageHostAllowed(u));
    if (thumbs.length > 0) return thumbs;
  }
  return [];
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    /* Openverse's thumb endpoint 406s on a bare image accept; offer a wildcard fallback. */
    headers: { "user-agent": UA, accept: "image/*,*/*;q=0.8" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!imageHostAllowed(res.url)) throw new Error("redirected off the image proxy host");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("empty body");
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`too large (${buf.length} bytes)`);
  return buf;
}

/** Decode → validate → square-crop to 256 → WebP under the 48KB launcher cap. */
async function processCandidate(raw: Buffer): Promise<Buffer | null> {
  const meta = await sharp(raw).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < MIN_SOURCE_PX || h < MIN_SOURCE_PX) return null;
  const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
  if (aspect > MAX_ASPECT) return null;
  for (const quality of [86, 72, 56, 40]) {
    const out = await sharp(raw)
      .resize(256, 256, { fit: "cover", position: "attention" })
      .webp({ quality, effort: 5 })
      .toBuffer();
    if (out.length <= LOGO_MAX_BYTES) return out;
  }
  return null;
}

export interface WebArtResult {
  bytes: Buffer;
  engine: "chromium" | "openverse";
}

/**
 * Finds and processes a real image for the query, or null (caller falls back
 * to procedural art). `seed` varies which candidate is tried first so two
 * launches with similar queries do not converge on the same picture.
 */
export async function fetchWebTokenImage(query: string, seed: string): Promise<WebArtResult | null> {
  const q = query.trim();
  if (q.length < 3) return null;
  const pw = loadPlaywright();
  let candidates: string[] = [];
  let engine: WebArtResult["engine"] = pw ? "chromium" : "openverse";
  if (pw) {
    try {
      candidates = await searchWithChromium(pw, q);
    } catch (err) {
      console.log(`[webart] chromium search failed (${String(err).slice(0, 120)}); trying openverse`);
    }
  }
  if (candidates.length === 0) {
    engine = "openverse";
    try {
      candidates = await searchWithOpenverse(q);
    } catch (err) {
      console.log(`[webart] openverse search failed: ${String(err).slice(0, 120)}`);
      return null;
    }
  }
  if (candidates.length === 0) {
    console.log(`[webart] no image candidates for "${q.slice(0, 60)}"`);
    return null;
  }
  const start = seedHash(seed) % candidates.length;
  let lastError = "all candidates below quality floor";
  for (let i = 0; i < Math.min(MAX_CANDIDATE_TRIES, candidates.length); i++) {
    const url = candidates[(start + i) % candidates.length];
    try {
      const processed = await processCandidate(await downloadImage(url));
      if (processed) {
        console.log(`[webart] sourced logo via ${engine} for "${q.slice(0, 60)}" (${processed.length} bytes)`);
        return { bytes: processed, engine };
      }
    } catch (err) {
      lastError = String(err).slice(0, 120);
    }
  }
  console.log(`[webart] no usable candidate for "${q.slice(0, 60)}" after ${MAX_CANDIDATE_TRIES} tries (last: ${lastError})`);
  return null;
}
