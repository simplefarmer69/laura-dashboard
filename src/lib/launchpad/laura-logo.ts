import sharp from "sharp";
import { hashSeed, mulberry32 } from "@/lib/launchpad/art";

/**
 * LAURA's own mark — the Sentinel: a guardian shield fused with a neural
 * beacon-eye, held inside two orbital rings. Theme: the future of humanity
 * and security. Fully deterministic vector art (no external assets), rendered
 * through the same sharp pipeline as launch art so it can ship anywhere the
 * launcher accepts a logo (256px WebP under the 48KB cap) and crisp at any
 * size in the console (raw SVG / large PNG).
 */

const SENTINEL = {
  cyan: "#22d3ee",
  teal: "#2dd4bf",
  violet: "#a78bfa",
  core: "#eafcff",
  ink: "#01040a",
} as const;

/** The canonical LAURA sentinel mark as a 512x512 SVG. */
export function lauraLogoSvg(): string {
  const c = SENTINEL;
  const rng = mulberry32(hashSeed("LAURA-SENTINEL-V1"));

  /* Deterministic starfield — humanity's sky behind the guardian. */
  let stars = "";
  for (let i = 0; i < 30; i++) {
    const x = Math.floor(rng() * 512);
    const y = Math.floor(rng() * 512);
    const o = (0.08 + rng() * 0.2).toFixed(2);
    const r = rng() > 0.85 ? 2.2 : 1.2;
    const fill = rng() > 0.7 ? c.violet : c.cyan;
    stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="${o}"/>`;
  }

  /* Iris ticks radiating from the beacon core. */
  let ticks = "";
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    const x1 = 256 + Math.cos(a) * 42;
    const y1 = 218 + Math.sin(a) * 42;
    const x2 = 256 + Math.cos(a) * 50;
    const y2 = 218 + Math.sin(a) * 50;
    ticks += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${c.teal}" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="lbg" cx="50%" cy="40%" r="78%">
      <stop offset="0%" stop-color="#07203a" stop-opacity="0.9"/>
      <stop offset="52%" stop-color="#030b16"/>
      <stop offset="100%" stop-color="${c.ink}"/>
    </radialGradient>
    <filter id="lglow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="lcore" x="-120%" y="-120%" width="340%" height="340%">
      <feGaussianBlur stdDeviation="12" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" fill="url(#lbg)"/>
  ${stars}

  <!-- Orbital guardianship rings (occluded by the shield fill) -->
  <g transform="rotate(-16 256 244)">
    <ellipse cx="256" cy="244" rx="214" ry="64" fill="none" stroke="${c.cyan}" stroke-width="2.5" opacity="0.5"/>
    <circle cx="62" cy="217" r="5" fill="${c.cyan}" filter="url(#lglow)"/>
  </g>
  <g transform="rotate(22 256 244)">
    <ellipse cx="256" cy="244" rx="201" ry="58" fill="none" stroke="${c.violet}" stroke-width="2" opacity="0.35"/>
    <circle cx="445" cy="264" r="4" fill="${c.violet}" opacity="0.9" filter="url(#lglow)"/>
  </g>

  <!-- Guardian shield -->
  <path d="M256 78 L404 128 C404 252 358 344 256 410 C154 344 108 252 108 128 Z"
    fill="#071a2c" stroke="${c.cyan}" stroke-width="9" stroke-linejoin="round" filter="url(#lglow)"/>
  <path d="M256 102 L382 145 C382 250 342 328 256 386 C170 328 130 250 130 145 Z"
    fill="none" stroke="${c.teal}" stroke-width="2.5" opacity="0.35"/>

  <!-- Neural circuit lattice: the shield thinks -->
  <g stroke="${c.teal}" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.9">
    <path d="M256 282 L256 336"/>
    <path d="M256 300 L212 300 L212 330"/>
    <path d="M256 300 L300 300 L300 330"/>
  </g>
  <circle cx="256" cy="342" r="6" fill="${c.cyan}" filter="url(#lglow)"/>
  <circle cx="212" cy="336" r="4.5" fill="${c.teal}"/>
  <circle cx="300" cy="336" r="4.5" fill="${c.teal}"/>

  <!-- Sentinel beacon-eye: humanity watched over -->
  <circle cx="256" cy="218" r="58" fill="none" stroke="${c.cyan}" stroke-width="7" filter="url(#lglow)"/>
  <circle cx="256" cy="218" r="33" fill="none" stroke="${c.violet}" stroke-width="4" opacity="0.85"/>
  ${ticks}
  <circle cx="256" cy="218" r="13" fill="${c.core}" filter="url(#lcore)"/>
</svg>`;
}

const LOGO_MAX_BYTES = 48 * 1024;

/** LAURA's logo as a 256px WebP under the launcher's 48KB logo cap. */
export async function generateLauraLogo(): Promise<Buffer> {
  const svg = Buffer.from(lauraLogoSvg());
  for (const quality of [88, 76, 60, 42]) {
    const out = await sharp(svg, { density: 144 })
      .resize(256, 256)
      .webp({ quality, effort: 5 })
      .toBuffer();
    if (out.length <= LOGO_MAX_BYTES) return out;
  }
  throw new Error("LAURA logo exceeds the 48KB logo cap at minimum quality");
}

/** High-fidelity PNG render for console surfaces (favicon, previews). */
export async function generateLauraLogoPng(size = 512): Promise<Buffer> {
  const svg = Buffer.from(lauraLogoSvg());
  const density = Math.max(72, Math.ceil((size / 512) * 288));
  return sharp(svg, { density }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}
