import fs from "node:fs/promises";
import path from "node:path";
import { chromiumExecutablePath, loadPlaywright } from "@/lib/swarm/browser";
import { X_IMAGE_MAX_BYTES, type XMediaInput } from "@/lib/publish/x";
import type { Draft, DraftMedia } from "@/lib/types";

/**
 * Screenshots for X posts. When the swarm announces a surface people can
 * open (The Lab, a launched token's page), the post carries a picture of it,
 * taken by the same headless Chromium the browser worker and the explorer
 * verifier use (SWARM_BROWSER=1). Files land under SWARM_DATA_DIR/media and
 * are referenced from Draft.media by file name only.
 *
 * Everything here is best effort: no Chromium, a slow page or a failed write
 * returns null and the post goes out as text. A picture is never a reason
 * to hold an announcement.
 */

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
export const MEDIA_DIR = path.join(DATA_DIR, "media");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 LAURA-swarm/1.0";
const PAGE_TIMEOUT_MS = 45_000;
/** The Lab reads the chain after hydration; give the listings a moment to paint. */
const SETTLE_MS = 3_500;
/** X renders a 16:9 image without cropping in the timeline. */
const VIEWPORT = { width: 1280, height: 720 };
/** Pictures older than this are retaken so a post never shows a stale page. */
const FRESH_MS = 30 * 60_000;

function log(msg: string): void {
  console.log(`[screenshot ${new Date().toISOString()}] ${msg}`);
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "shot";
}

export interface ScreenshotOptions {
  /** File stem under MEDIA_DIR (sanitized); the same stem re-uses a fresh file. */
  name: string;
  alt: string;
  /** Capture the whole page instead of the first viewport. */
  fullPage?: boolean;
}

/**
 * Captures `url` to MEDIA_DIR/<name>.png and returns the DraftMedia record,
 * or null when Chromium is unavailable or the page did not render. A file
 * newer than FRESH_MS is returned as is.
 */
export async function captureScreenshot(url: string, opts: ScreenshotOptions): Promise<DraftMedia | null> {
  const file = `${safeName(opts.name)}.png`;
  const target = path.join(MEDIA_DIR, file);
  try {
    const st = await fs.stat(target);
    if (Date.now() - st.mtimeMs < FRESH_MS && st.size > 0 && st.size <= X_IMAGE_MAX_BYTES) {
      return { file, alt: opts.alt, sourceUrl: url };
    }
  } catch {
    /* no cached picture */
  }
  const pw = loadPlaywright();
  if (!pw) {
    log(`chromium unavailable on this host (SWARM_BROWSER); no picture for ${url}`);
    return null;
  }
  const browser = await pw.chromium.launch({ headless: true, executablePath: chromiumExecutablePath() });
  try {
    const context = await browser.newContext({ userAgent: UA, javaScriptEnabled: true, viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(SETTLE_MS);
      const png = await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false });
      if (png.length === 0 || png.length > X_IMAGE_MAX_BYTES) {
        log(`picture of ${url} is ${png.length} bytes; outside the upload window, dropped`);
        return null;
      }
      await fs.mkdir(MEDIA_DIR, { recursive: true });
      await fs.writeFile(target, png);
      log(`captured ${url} -> media/${file} (${Math.round(png.length / 1024)} KB)`);
      return { file, alt: opts.alt, sourceUrl: url };
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  } catch (err) {
    log(`capture of ${url} failed: ${String(err).slice(0, 200)}`);
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Reads a draft's attached images from MEDIA_DIR as upload inputs; missing files are skipped with a note. */
export async function loadDraftMedia(draft: Pick<Draft, "media">): Promise<{ inputs: XMediaInput[]; missing: string[] }> {
  const inputs: XMediaInput[] = [];
  const missing: string[] = [];
  for (const m of draft.media ?? []) {
    if (!m.file || m.file.includes("/") || m.file.includes("..")) {
      missing.push(`${m.file}: bad file name`);
      continue;
    }
    try {
      const bytes = await fs.readFile(path.join(MEDIA_DIR, m.file));
      const ext = path.extname(m.file).toLowerCase();
      const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
      inputs.push({ bytes, mimeType, alt: m.alt });
    } catch (err) {
      missing.push(`${m.file}: ${String(err).slice(0, 80)}`);
    }
  }
  return { inputs, missing };
}
