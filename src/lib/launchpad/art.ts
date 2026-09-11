import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ART_PALETTES as PALETTE_NAMES } from "@/lib/launchpad/spec";

/**
 * Procedural token art: LAURA designs each launch's logo herself.
 * Mint picks a motif + palette; this renders a 256px WebP in the
 * StonkBrokers terminal aesthetic, under the launcher's 48KB logo cap.
 * No external image API needed — fully deterministic from the spec.
 *
 * V2 art direction ("sentinel era"): deep space-dark grounds, neon accents,
 * orbital framing and a restyled LAURA signature — futuristic guardianship,
 * the future of humanity and security. Stored art is versioned: launches
 * rendered before V2 keep their original files untouched.
 *
 * V3 adds COMPOSITION variety (operator report 2026-09-11: "mint is making
 * tokens that all use the same image style"). Five distinct layouts share the
 * palette/motif language; Mint picks one per token (artStyle) or the seed
 * assigns one, so consecutive launches stop looking like one template.
 */

/** Bump when the composition changes so old launches keep their stored art. */
export const ART_VERSION = 3;

export const ART_STYLES = ["orbital", "poster", "badge", "glitch", "minimal"] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

/* Keyed by the palette tuple in spec.ts (the zod-enum source of truth), so a
   palette added on either side is a compile error until both agree. */
export const ART_PALETTES: Record<(typeof PALETTE_NAMES)[number], { glow: string; accent: string; dim: string }> = {
  emerald: { glow: "#34d399", accent: "#d1fae5", dim: "#053f31" },
  amber: { glow: "#fbbf24", accent: "#fef3c7", dim: "#4a2a08" },
  crimson: { glow: "#f87171", accent: "#fee2e2", dim: "#4c1212" },
  violet: { glow: "#a78bfa", accent: "#ede9fe", dim: "#331a63" },
  cyan: { glow: "#22d3ee", accent: "#cffafe", dim: "#0c3d4d" },
  gold: { glow: "#facc15", accent: "#fef9c3", dim: "#48310c" },
  /* Sentinel-era additions: colder, more futuristic grounds */
  ion: { glow: "#60a5fa", accent: "#dbeafe", dim: "#12295a" },
  aurora: { glow: "#2dd4bf", accent: "#ccfbf1", dim: "#0a3d38" },
};

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
  "sentinel",
  "orbit",
  "neural",
  "beacon",
] as const;

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
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

  /* Sentinel-era motifs (checked first so "guardian" doesn't fall through to plain shield) */
  if (has("sentinel", "guardian", "protector"))
    return `<path d="M50 6 L86 18 C86 50 76 76 50 94 C24 76 14 50 14 18 Z" ${S}/>
      <circle cx="50" cy="38" r="12" ${S}/>
      <circle cx="50" cy="38" r="4" fill="${c.accent}"/>
      <path d="M50 52 L50 66 M50 58 L38 58 L38 68 M50 58 L62 58 L62 68" stroke="${c.glow}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <circle cx="50" cy="70" r="3" fill="${c.glow}"/><circle cx="38" cy="71" r="2.5" fill="${c.glow}"/><circle cx="62" cy="71" r="2.5" fill="${c.glow}"/>`;
  if (has("orbit", "satellite", "ring-world"))
    return `<circle cx="50" cy="50" r="19" ${S}/>
      <path d="M40 44 C46 40 56 42 60 48 M38 56 L48 56" stroke="${c.glow}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <g transform="rotate(-20 50 50)">
        <ellipse cx="50" cy="50" rx="42" ry="14" stroke="${c.glow}" stroke-width="3" fill="none"/>
        <circle cx="8" cy="50" r="4" fill="${c.accent}"/>
      </g>`;
  if (has("neural", "bloom", "network", "synapse", "mind"))
    return `<circle cx="50" cy="50" r="8" ${S}/>
      <path d="M50 42 L50 18 M57 46 L78 32 M58 53 L82 62 M50 58 L50 82 M43 53 L18 62 M43 46 L22 32" stroke="${c.glow}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <circle cx="50" cy="14" r="4.5" fill="${c.glow}"/><circle cx="82" cy="30" r="4.5" fill="${c.glow}"/>
      <circle cx="86" cy="63" r="4.5" fill="${c.glow}"/><circle cx="50" cy="86" r="4.5" fill="${c.glow}"/>
      <circle cx="14" cy="63" r="4.5" fill="${c.glow}"/><circle cx="18" cy="30" r="4.5" fill="${c.glow}"/>
      <circle cx="50" cy="50" r="3" fill="${c.accent}"/>`;
  if (has("beacon", "lighthouse", "tower"))
    return `<path d="M42 40 L58 40 L54 84 L46 84 Z" ${S}/>
      <circle cx="50" cy="26" r="8" ${S}/>
      <path d="M36 26 L20 26 M64 26 L80 26 M39 15 L28 6 M61 15 L72 6" stroke="${c.accent}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <path d="M34 92 L66 92" ${S}/>
      <circle cx="50" cy="26" r="2.5" fill="${c.accent}"/>`;

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
  /** Composition (one of ART_STYLES); seeded from the spec when absent. */
  style?: string | null;
}

const MONO = "Cascadia Mono, DejaVu Sans Mono, monospace";

interface ArtCtx {
  c: { glow: string; accent: string; dim: string };
  rng: () => number;
  glyph: string;
  sym: string;
}

function starfield(ctx: ArtCtx, count: number): string {
  let specks = "";
  for (let i = 0; i < count; i++) {
    const x = Math.floor(ctx.rng() * 512);
    const y = Math.floor(ctx.rng() * 512);
    const o = (0.06 + ctx.rng() * 0.18).toFixed(2);
    const r = ctx.rng() > 0.85 ? 2.4 : 1.3;
    const fill = ctx.rng() > 0.75 ? ctx.c.accent : ctx.c.glow;
    specks += `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="${o}"/>`;
  }
  return specks;
}

function svgShell(c: ArtCtx["c"], body: string, bg?: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="78%">
      <stop offset="0%" stop-color="${c.dim}" stop-opacity="0.9"/>
      <stop offset="52%" stop-color="#050a12"/>
      <stop offset="100%" stop-color="#02040a"/>
    </radialGradient>
    <linearGradient id="beam" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c.glow}" stop-opacity="0.22"/>
      <stop offset="55%" stop-color="${c.glow}" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" fill="${bg ?? "url(#bg)"}"/>
  ${body}
</svg>`;
}

/** V2 look: grid + starfield, orbital ring, glyph high, symbol low, footer signature. */
function styleOrbital(ctx: ArtCtx): string {
  const { c, rng, glyph, sym } = ctx;
  const fontSize = Math.min(70, Math.floor(390 / sym.length));
  let grid = "";
  for (let i = 1; i < 8; i++) {
    const p = i * 64;
    grid += `<path d="M${p} 0 L${p} 512 M0 ${p} L512 ${p}" stroke="${c.glow}" stroke-width="1" opacity="0.045"/>`;
  }
  const orbitTilt = Math.floor(rng() * 24) - 26;
  return svgShell(
    c,
    `${grid}
  ${starfield(ctx, 30)}
  <g transform="rotate(${orbitTilt} 256 206)">
    <ellipse cx="256" cy="206" rx="196" ry="58" fill="none" stroke="${c.glow}" stroke-width="2" opacity="0.4"/>
    <circle cx="60" cy="196" r="4.5" fill="${c.glow}" opacity="0.9" filter="url(#glow)"/>
  </g>
  <path d="M26 26 L26 62 M26 26 L62 26 M486 26 L486 62 M486 26 L450 26 M26 486 L26 450 M26 486 L62 486 M486 486 L486 450 M486 486 L450 486" stroke="${c.glow}" stroke-width="3" opacity="0.45" fill="none"/>
  <g transform="translate(126, 66) scale(2.6)" filter="url(#glow)">${glyph}</g>
  <text x="256" y="400" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="${fontSize}" fill="${c.accent}" letter-spacing="3" filter="url(#glow)">${sym}</text>
  <g opacity="0.85">
    <path d="M118 456 L216 456 M296 456 L394 456" stroke="${c.glow}" stroke-width="1.5" opacity="0.6"/>
    <text x="256" y="463" text-anchor="middle" font-family="${MONO}" font-size="20" fill="${c.glow}" letter-spacing="8">LAURA</text>
  </g>`,
  );
}

/** Full-bleed glyph, diagonal light beams, solid symbol bar, vertical signature. */
function stylePoster(ctx: ArtCtx): string {
  const { c, rng, glyph, sym } = ctx;
  const fontSize = Math.min(56, Math.floor(330 / sym.length));
  const beamTilt = Math.floor(rng() * 20) - 10;
  return svgShell(
    c,
    `<g transform="rotate(${beamTilt} 256 256)">
    <rect x="-120" y="-80" width="380" height="700" fill="url(#beam)"/>
    <rect x="330" y="-80" width="90" height="700" fill="url(#beam)" opacity="0.6"/>
  </g>
  ${starfield(ctx, 14)}
  <g transform="translate(76, 40) scale(3.6)" filter="url(#glow)" opacity="0.96">${glyph}</g>
  <rect x="0" y="404" width="512" height="76" fill="${c.dim}" opacity="0.88"/>
  <path d="M0 404 L512 404" stroke="${c.glow}" stroke-width="2" opacity="0.7"/>
  <text x="30" y="456" font-family="${MONO}" font-weight="700" font-size="${fontSize}" fill="${c.accent}" letter-spacing="2">${sym}</text>
  <text x="488" y="452" text-anchor="end" font-family="${MONO}" font-size="17" fill="${c.glow}" letter-spacing="6" opacity="0.9">LAURA</text>
  <text x="486" y="120" font-family="${MONO}" font-size="15" fill="${c.glow}" letter-spacing="7" opacity="0.5" transform="rotate(90 486 120)">SENTINEL</text>`,
  );
}

/** Circular emblem: concentric rings with tick marks, glyph centered, symbol chip below. */
function styleBadge(ctx: ArtCtx): string {
  const { c, rng, glyph, sym } = ctx;
  const fontSize = Math.min(44, Math.floor(300 / sym.length));
  let ticks = "";
  const tickCount = 24 + Math.floor(rng() * 12) * 4;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * Math.PI * 2;
    const long = i % 6 === 0;
    const r1 = long ? 186 : 194;
    ticks += `<path d="M${(256 + Math.cos(a) * r1).toFixed(1)} ${(226 + Math.sin(a) * r1).toFixed(1)} L${(256 + Math.cos(a) * 202).toFixed(1)} ${(226 + Math.sin(a) * 202).toFixed(1)}" stroke="${c.glow}" stroke-width="${long ? 3 : 1.5}" opacity="${long ? 0.7 : 0.35}"/>`;
  }
  return svgShell(
    c,
    `${starfield(ctx, 12)}
  <circle cx="256" cy="226" r="202" fill="none" stroke="${c.glow}" stroke-width="2" opacity="0.5"/>
  <circle cx="256" cy="226" r="160" fill="${c.dim}" opacity="0.35"/>
  <circle cx="256" cy="226" r="160" fill="none" stroke="${c.glow}" stroke-width="2.5" opacity="0.8"/>
  <circle cx="256" cy="226" r="146" fill="none" stroke="${c.accent}" stroke-width="1" opacity="0.3"/>
  ${ticks}
  <g transform="translate(151, 121) scale(2.1)" filter="url(#glow)">${glyph}</g>
  <rect x="${256 - (sym.length * fontSize * 0.62 + 44) / 2}" y="436" width="${sym.length * fontSize * 0.62 + 44}" height="56" rx="10" fill="${c.dim}" opacity="0.85" stroke="${c.glow}" stroke-width="1.5"/>
  <text x="256" y="476" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="${fontSize}" fill="${c.accent}" letter-spacing="2">${sym}</text>
  <text x="256" y="26" text-anchor="middle" font-family="${MONO}" font-size="15" fill="${c.glow}" letter-spacing="9" opacity="0.7">LAURA</text>`,
  );
}

/** RGB-split glyph, scanlines and slice bars — terminal interference. */
function styleGlitch(ctx: ArtCtx): string {
  const { c, rng, glyph, sym } = ctx;
  const fontSize = Math.min(62, Math.floor(360 / sym.length));
  let scan = "";
  for (let y = 8; y < 512; y += 14) scan += `<path d="M0 ${y} L512 ${y}" stroke="#000" stroke-width="4" opacity="0.14"/>`;
  let bars = "";
  for (let i = 0; i < 5; i++) {
    const y = Math.floor(rng() * 460);
    const h = 4 + Math.floor(rng() * 12);
    const dx = Math.floor(rng() * 40) - 20;
    bars += `<rect x="${dx}" y="${y}" width="512" height="${h}" fill="${c.glow}" opacity="0.10"/>`;
  }
  const off = 5 + Math.floor(rng() * 4);
  return svgShell(
    c,
    `${bars}
  <g transform="translate(${120 - off}, 96) scale(2.7)" opacity="0.5">${glyph.replaceAll(ctx.c.glow, "#f0335f").replaceAll(ctx.c.accent, "#f0335f")}</g>
  <g transform="translate(${120 + off}, 96) scale(2.7)" opacity="0.5">${glyph.replaceAll(ctx.c.glow, "#22d3ee").replaceAll(ctx.c.accent, "#22d3ee")}</g>
  <g transform="translate(120, 96) scale(2.7)" filter="url(#glow)">${glyph}</g>
  <text x="${258 + off}" y="422" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="${fontSize}" fill="#f0335f" letter-spacing="3" opacity="0.55">${sym}</text>
  <text x="${254 - off}" y="418" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="${fontSize}" fill="#22d3ee" letter-spacing="3" opacity="0.55">${sym}</text>
  <text x="256" y="420" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="${fontSize}" fill="${c.accent}" letter-spacing="3" filter="url(#glow)">${sym}</text>
  ${scan}
  <text x="30" y="490" font-family="${MONO}" font-size="16" fill="${c.glow}" letter-spacing="7" opacity="0.8">LAURA//SIGNAL</text>`,
  );
}

/** Near-black field, thin frame, huge symbol, small glyph as a corner mark. */
function styleMinimal(ctx: ArtCtx): string {
  const { c, glyph, sym } = ctx;
  const fontSize = Math.min(96, Math.floor(430 / sym.length));
  return svgShell(
    c,
    `<rect x="22" y="22" width="468" height="468" fill="none" stroke="${c.glow}" stroke-width="1.5" opacity="0.55"/>
  <rect x="30" y="30" width="452" height="452" fill="none" stroke="${c.glow}" stroke-width="0.75" opacity="0.25"/>
  <g transform="translate(48, 48) scale(0.9)" opacity="0.9" filter="url(#glow)">${glyph}</g>
  <text x="256" y="${276 + fontSize * 0.36}" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="${fontSize}" fill="${c.accent}" letter-spacing="4" filter="url(#glow)">${sym}</text>
  <path d="M170 330 L342 330" stroke="${c.glow}" stroke-width="2" opacity="0.6"/>
  <text x="256" y="452" text-anchor="middle" font-family="${MONO}" font-size="17" fill="${c.glow}" letter-spacing="9" opacity="0.85">LAURA</text>`,
    "#04070d",
  );
}

const STYLE_RENDERERS: Record<ArtStyle, (ctx: ArtCtx) => string> = {
  orbital: styleOrbital,
  poster: stylePoster,
  badge: styleBadge,
  glitch: styleGlitch,
  minimal: styleMinimal,
};

function buildSvg(spec: TokenArtSpec): string {
  const paletteKey = (spec.palette && spec.palette in ART_PALETTES ? spec.palette : "emerald") as ArtPalette;
  const c = ART_PALETTES[paletteKey];
  const rng = mulberry32(hashSeed(`${spec.symbol}:${spec.name}`));
  const style: ArtStyle =
    spec.style && (ART_STYLES as readonly string[]).includes(spec.style)
      ? (spec.style as ArtStyle)
      : ART_STYLES[hashSeed(`style:${spec.symbol}:${spec.name}`) % ART_STYLES.length];
  const ctx: ArtCtx = { c, rng, glyph: motifGlyph(spec.motif ?? "chart", c), sym: `$${spec.symbol.slice(0, 10)}` };
  return STYLE_RENDERERS[style](ctx);
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

/** New art is written under the current version; legacy `<id>.webp` files stay untouched. */
export async function saveLaunchArt(launchId: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(ART_DIR, { recursive: true });
  await fs.writeFile(path.join(ART_DIR, `${launchId}.v${ART_VERSION}.webp`), bytes);
}

/** Reads stored art: current version first, then any older version, then legacy unversioned. */
export async function readLaunchArt(launchId: string): Promise<Buffer | null> {
  const candidates = [];
  for (let v = ART_VERSION; v >= 2; v--) candidates.push(`${launchId}.v${v}.webp`);
  candidates.push(`${launchId}.webp`);
  for (const file of candidates) {
    try {
      return await fs.readFile(path.join(ART_DIR, file));
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Reads stored art, generating (and persisting) it on demand. */
export async function ensureLaunchArt(launchId: string, spec: TokenArtSpec): Promise<Buffer> {
  const existing = await readLaunchArt(launchId);
  if (existing) return existing;
  const bytes = await generateTokenArt(spec);
  await saveLaunchArt(launchId, bytes);
  return bytes;
}
