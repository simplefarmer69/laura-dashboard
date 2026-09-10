import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

/**
 * Procedural token art: LAURA designs each launch's logo herself.
 * Mint picks a motif + palette; this renders a 256px WebP in the
 * StonkBrokers terminal aesthetic, under the launcher's 48KB logo cap.
 * No external image API needed — fully deterministic from the spec.
 */

export const ART_PALETTES = {
  emerald: { glow: "#34d399", accent: "#d1fae5", dim: "#064e3b" },
  amber: { glow: "#fbbf24", accent: "#fef3c7", dim: "#78350f" },
  crimson: { glow: "#f87171", accent: "#fee2e2", dim: "#7f1d1d" },
  violet: { glow: "#a78bfa", accent: "#ede9fe", dim: "#4c1d95" },
  cyan: { glow: "#22d3ee", accent: "#cffafe", dim: "#155e75" },
  gold: { glow: "#facc15", accent: "#fef9c3", dim: "#713f12" },
} as const;

export type ArtPalette = keyof typeof ART_PALETTES;

export const ART_MOTIFS = [
  "bell",
  "chart",
  "rocket",
  "bull",
  "clock",
  "wave",
  "bolt",
  "diamond",
  "shield",
  "moon",
  "flame",
  "crown",
  "eye",
  "star",
  "key",
  "globe",
  "robot",
] as const;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Glyphs drawn stroke-first in a 100x100 box, terminal-neon style. */
function motifGlyph(motif: string, c: { glow: string; accent: string }): string {
  const m = motif.toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => m.includes(k));
  const S = `stroke="${c.glow}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

  if (has("bell", "ring", "alarm"))
    return `<path d="M50 14 C33 14 28 30 28 46 L28 62 L20 74 L80 74 L72 62 L72 46 C72 30 67 14 50 14 Z" ${S}/>
      <circle cx="50" cy="84" r="6" fill="${c.glow}"/>`;
  if (has("rocket", "ship", "launch"))
    return `<path d="M50 8 C64 22 66 44 60 64 L40 64 C34 44 36 22 50 8 Z" ${S}/>
      <path d="M40 60 L26 74 L38 72 M60 60 L74 74 L62 72" ${S}/>
      <path d="M44 70 L50 92 L56 70" stroke="${c.accent}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <circle cx="50" cy="34" r="7" ${S}/>`;
  if (has("bull", "horn", "ox"))
    return `<path d="M14 20 C14 44 30 54 50 54 C70 54 86 44 86 20" ${S}/>
      <path d="M14 20 C24 26 32 26 38 22 M86 20 C76 26 68 26 62 22" ${S}/>
      <path d="M38 62 L50 84 L62 62" ${S}/>`;
  if (has("clock", "time", "hour"))
    return `<circle cx="50" cy="50" r="36" ${S}/>
      <path d="M50 30 L50 52 L68 62" ${S}/>
      <circle cx="50" cy="50" r="3.5" fill="${c.glow}"/>`;
  if (has("wave", "signal", "pulse", "sound"))
    return `<path d="M8 50 L24 50 L32 26 L44 74 L56 32 L66 62 L74 50 L92 50" ${S}/>
      <circle cx="92" cy="50" r="4" fill="${c.accent}"/>`;
  if (has("bolt", "lightning", "thunder", "electric"))
    return `<path d="M56 8 L28 54 L46 54 L40 92 L74 40 L54 40 Z" ${S} fill="${c.glow}22"/>`;
  if (has("diamond", "gem", "jewel", "crystal"))
    return `<path d="M30 22 L70 22 L88 44 L50 88 L12 44 Z" ${S}/>
      <path d="M12 44 L88 44 M30 22 L50 88 L70 22 M50 22 L38 44 M50 22 L62 44" stroke="${c.glow}" stroke-width="2.5" fill="none"/>`;
  if (has("shield", "guard", "safe"))
    return `<path d="M50 8 L84 20 C84 52 74 76 50 92 C26 76 16 52 16 20 Z" ${S}/>
      <path d="M36 48 L46 60 L66 34" ${S}/>`;
  if (has("moon", "night", "lunar"))
    return `<path d="M62 10 C42 16 30 34 30 52 C30 72 46 88 66 88 C70 88 74 87 78 86 C60 80 48 64 48 46 C48 31 54 18 62 10 Z" ${S}/>
      <circle cx="76" cy="26" r="3" fill="${c.accent}"/><circle cx="86" cy="42" r="2" fill="${c.accent}"/>`;
  if (has("flame", "fire", "burn"))
    return `<path d="M50 8 C58 24 74 32 74 56 C74 74 64 88 50 88 C36 88 26 74 26 56 C26 44 32 36 36 30 C36 40 42 44 46 44 C42 32 44 18 50 8 Z" ${S}/>
      <path d="M50 62 C56 66 58 72 54 80 C48 84 42 80 42 74 C42 68 46 66 50 62 Z" stroke="${c.accent}" stroke-width="3" fill="none"/>`;
  if (has("crown", "king", "queen", "royal"))
    return `<path d="M16 70 L16 34 L34 50 L50 24 L66 50 L84 34 L84 70 Z" ${S}/>
      <path d="M16 80 L84 80" ${S}/><circle cx="50" cy="16" r="4" fill="${c.glow}"/>`;
  if (has("eye", "vision", "watch", "oracle"))
    return `<path d="M8 50 C24 26 76 26 92 50 C76 74 24 74 8 50 Z" ${S}/>
      <circle cx="50" cy="50" r="13" ${S}/><circle cx="50" cy="50" r="5" fill="${c.glow}"/>`;
  if (has("star", "nova", "spark"))
    return `<path d="M50 8 L60 38 L92 38 L66 56 L76 88 L50 68 L24 88 L34 56 L8 38 L40 38 Z" ${S}/>`;
  if (has("key", "unlock", "access"))
    return `<circle cx="34" cy="36" r="18" ${S}/>
      <path d="M46 50 L82 86 M70 74 L80 64 M60 64 L70 54" ${S}/>`;
  if (has("globe", "world", "planet", "earth"))
    return `<circle cx="50" cy="50" r="36" ${S}/>
      <ellipse cx="50" cy="50" rx="16" ry="36" ${S}/>
      <path d="M16 38 L84 38 M16 62 L84 62" stroke="${c.glow}" stroke-width="3" fill="none"/>`;
  if (has("robot", "ai", "machine", "agent", "cyborg"))
    return `<rect x="24" y="26" width="52" height="44" rx="8" ${S}/>
      <circle cx="40" cy="46" r="5" fill="${c.glow}"/><circle cx="60" cy="46" r="5" fill="${c.glow}"/>
      <path d="M38 60 L62 60 M50 26 L50 12 M14 42 L24 42 M76 42 L86 42" ${S}/>
      <circle cx="50" cy="10" r="4" fill="${c.accent}"/>
      <path d="M34 70 L34 84 M66 70 L66 84 M42 70 L42 80 M58 70 L58 80" ${S}/>`;
  /* Default: candlestick chart — the launcher's native language */
  return `<path d="M22 68 L22 36 M38 78 L38 26 M54 60 L54 18 M70 52 L70 10" ${S}/>
    <rect x="16" y="44" width="12" height="16" fill="${c.glow}"/>
    <rect x="32" y="36" width="12" height="30" fill="${c.glow}"/>
    <rect x="48" y="26" width="12" height="24" fill="${c.glow}"/>
    <rect x="64" y="18" width="12" height="22" fill="${c.accent}"/>`;
}

export interface TokenArtSpec {
  name: string;
  symbol: string;
  motif?: string | null;
  palette?: string | null;
}

function buildSvg(spec: TokenArtSpec): string {
  const paletteKey = (spec.palette && spec.palette in ART_PALETTES ? spec.palette : "emerald") as ArtPalette;
  const c = ART_PALETTES[paletteKey];
  const rng = mulberry32(hashSeed(`${spec.symbol}:${spec.name}`));
  const glyph = motifGlyph(spec.motif ?? "chart", c);

  const sym = `$${spec.symbol.slice(0, 10)}`;
  const fontSize = Math.min(72, Math.floor(400 / sym.length));

  /* Sparse "data rain" specks seeded by the spec */
  let specks = "";
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(rng() * 512);
    const y = Math.floor(rng() * 512);
    const o = (0.06 + rng() * 0.16).toFixed(2);
    const r = rng() > 0.8 ? 2.5 : 1.4;
    specks += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c.glow}" opacity="${o}"/>`;
  }

  let grid = "";
  for (let i = 1; i < 8; i++) {
    const p = i * 64;
    grid += `<path d="M${p} 0 L${p} 512 M0 ${p} L512 ${p}" stroke="${c.glow}" stroke-width="1" opacity="0.07"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="${c.dim}" stop-opacity="0.85"/>
      <stop offset="55%" stop-color="#08110c"/>
      <stop offset="100%" stop-color="#04080a"/>
    </radialGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  ${grid}
  ${specks}
  <path d="M26 26 L26 58 M26 26 L58 26 M486 26 L486 58 M486 26 L454 26 M26 486 L26 454 M26 486 L58 486 M486 486 L486 454 M486 486 L454 486" stroke="${c.glow}" stroke-width="4" opacity="0.55" fill="none"/>
  <g transform="translate(126, 66) scale(2.6)" filter="url(#glow)">${glyph}</g>
  <text x="256" y="404" text-anchor="middle" font-family="Cascadia Mono, DejaVu Sans Mono, monospace" font-weight="700" font-size="${fontSize}" fill="${c.accent}" letter-spacing="3" filter="url(#glow)">${sym}</text>
  <text x="256" y="464" text-anchor="middle" font-family="Cascadia Mono, DejaVu Sans Mono, monospace" font-size="21" fill="${c.glow}" opacity="0.8" letter-spacing="6">— LAURA —</text>
</svg>`;
}

const LOGO_MAX_BYTES = 48 * 1024;

/** Renders the token logo as a 256px WebP under the launcher's 48KB cap. */
export async function generateTokenArt(spec: TokenArtSpec): Promise<Buffer> {
  const svg = Buffer.from(buildSvg(spec));
  for (const quality of [88, 76, 60, 42]) {
    const out = await sharp(svg, { density: 144 })
      .resize(256, 256)
      .webp({ quality, effort: 5 })
      .toBuffer();
    if (out.length <= LOGO_MAX_BYTES) return out;
  }
  throw new Error("Token art exceeds the 48KB logo cap at minimum quality");
}

/* ------------------------- On-disk art store ------------------------- */

const ART_DIR = process.env.SWARM_DATA_DIR
  ? path.join(process.env.SWARM_DATA_DIR, "launch-art")
  : path.join(process.cwd(), "data", "launch-art");

export async function saveLaunchArt(launchId: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(ART_DIR, { recursive: true });
  await fs.writeFile(path.join(ART_DIR, `${launchId}.webp`), bytes);
}

export async function readLaunchArt(launchId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(ART_DIR, `${launchId}.webp`));
  } catch {
    return null;
  }
}

/** Reads stored art, generating (and persisting) it on demand. */
export async function ensureLaunchArt(launchId: string, spec: TokenArtSpec): Promise<Buffer> {
  const existing = await readLaunchArt(launchId);
  if (existing) return existing;
  const bytes = await generateTokenArt(spec);
  await saveLaunchArt(launchId, bytes);
  return bytes;
}
