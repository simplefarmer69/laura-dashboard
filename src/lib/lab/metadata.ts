import { z } from "zod";

/**
 * Seller-published storefront metadata for a listing (one JSON string in the
 * Lab registry, 3000 bytes max). Everything is UNTRUSTED seller input:
 * frontends render text as text and only follow http(s)/ipfs links.
 */

export const METADATA_MAX_BYTES = 3000;

const link = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || isSafeUrl(v), "Links must start with https://, http:// or ipfs://");

export const auditSchema = z.object({
  title: z.string().trim().min(1).max(80),
  url: link.refine((v) => v !== "", "Audit link is required"),
});

export const metadataSchema = z.object({
  name: z.string().trim().max(80).default(""),
  description: z.string().trim().max(1500).default(""),
  image: link.default(""),
  website: link.default(""),
  github: link.default(""),
  docs: link.default(""),
  x: z.string().trim().max(60).default(""),
  telegram: link.default(""),
  discord: link.default(""),
  audits: z.array(auditSchema).max(6).default([]),
  tags: z.array(z.string().trim().min(1).max(24)).max(6).default([]),
});

export type ListingMetadata = z.infer<typeof metadataSchema>;

export const EMPTY_METADATA: ListingMetadata = metadataSchema.parse({});

export function isSafeUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "ipfs:";
  } catch {
    return false;
  }
}

/** ipfs:// links render through a public gateway; everything else passes through unchanged. */
export function displayUrl(v: string): string {
  if (v.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${v.slice("ipfs://".length)}`;
  return v;
}

/** "@handle", "handle" or a full x.com/twitter.com URL -> https://x.com/handle (or null when it is not a handle/URL). */
export function xProfileUrl(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const m = s.match(/^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?$/);
  return m ? `https://x.com/${m[1]}` : null;
}

/** Parses a registry record; malformed or hostile JSON degrades to empty metadata instead of breaking the page. */
export function parseMetadata(raw: string): { meta: ListingMetadata; ok: boolean } {
  if (!raw || raw.length > METADATA_MAX_BYTES * 2) return { meta: EMPTY_METADATA, ok: false };
  try {
    const parsed = metadataSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { meta: parsed.data, ok: true };
  } catch {
    /* fall through */
  }
  return { meta: EMPTY_METADATA, ok: false };
}

/** Compact JSON with empty fields dropped, so sellers pay for what they filled in. */
export function serializeMetadata(meta: ListingMetadata): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
    if (Array.isArray(v) && v.length > 0) out[k] = v;
  }
  return JSON.stringify(out);
}

export function metadataBytes(meta: ListingMetadata): number {
  return new TextEncoder().encode(serializeMetadata(meta)).length;
}
