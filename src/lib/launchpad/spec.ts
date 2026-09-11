import { z } from "zod";
import type { LaunchProposal } from "@/lib/types";
import { PAD_LANE_KEYS } from "@/lib/launchpad/contracts";

/**
 * Single source of truth for Safe Launch V2 pad bounds and launch-queue
 * duplicate rules. Used by Mint's cycle schema (tasks.ts) and the manual
 * create API (/api/launches) so the two paths can never drift apart.
 * These mirror the pad's on-chain bounds; deployLaunch re-validates live.
 */
export const launchSpecShape = {
  lane: z
    .enum(PAD_LANE_KEYS)
    .describe(
      "Quote lane pad the launch deploys on. Pick from the LANE MENU in the prompt; stock lanes marked CLOSED must not be picked.",
    ),
  name: z.string().min(3).max(48),
  symbol: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z0-9]+$/),
  supplyTokens: z.number().min(1_000_000).max(1e12),
  startMcapUsd: z.number().min(1000).max(1_000_000),
  gradMcapUsd: z.number().min(50_000).max(10_000_000),
  startTaxBps: z.number().min(0).max(9900),
  taxDecayPerMinuteBps: z.number().min(0).max(2000),
  /* Pad-enforced floor: createLaunch REVERTS below MIN_POST_TAX_BPS() = 100
     (verified 2026-09-10 by simulation; MIN/MAX_POST_TAX_BPS read 100/500 on
     all 8 pads including the five stock lanes, and postTaxBps 100 simulates
     clean on every pad). Zod allowing 0 here used to let a spec through that
     could only ever fail at deploy. */
  postTaxBps: z.number().min(100).max(500),
  sellsEnabled: z.boolean(),
  bufferSecs: z.number().min(600).max(3600),
} as const;

/* Palette vocabulary, as the literal tuple zod's enum needs. This is the
   source of truth: art.ts types its palette map with these keys, so adding a
   palette on either side without the other is a compile error (no drift). */
export const ART_PALETTES = ["emerald", "amber", "crimson", "violet", "cyan", "gold", "ion", "aurora"] as const;

/**
 * Names the Stonklauncher floor HIDES. The site (and the Telegram deploy
 * bot) fold every launch name+symbol and drop rows containing these needles
 * (house brand + operator names), so a launch carrying one deploys fine but
 * is invisible everywhere: no card, no token page, no announcement. Launch
 * 281 "Apes Clock In" (CLKIN, 2026-09-10) burned a deploy exactly this way.
 * Mirror of RESERVED_LAUNCH_NAMES in the stonkbrokers floor code.
 */
export const RESERVED_LAUNCH_NEEDLES = ["clockin", "admir", "zlatic"] as const;

/**
 * Compact version of the floor's homoglyph fold. LAURA's specs are ASCII
 * (the symbol regex enforces it), so lowercasing, leet digits and the l->i
 * fold cover everything she can emit; the floor's Unicode confusables map is
 * unreachable from here. Needles run through the same fold so l->i stays
 * symmetric ("clockin" -> "ciockin" on both sides).
 */
function foldLaunchName(s: string): string {
  const leet: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", l: "i", "|": "i", "!": "i" };
  return s
    .normalize("NFKD")
    .toLowerCase()
    .split("")
    .map((ch) => leet[ch] ?? ch)
    .join("")
    .replace(/[^a-z]/g, "");
}

/**
 * Returns the reserved needle a name/symbol pair would trip on the floor,
 * or null when the pair is clean. Checks both concatenation orders because
 * the floor does (a needle split across name and symbol still hides the row).
 */
export function reservedLaunchNameHit(name: string, symbol: string): string | null {
  const n = foldLaunchName(name);
  const s = foldLaunchName(symbol);
  for (const needle of RESERVED_LAUNCH_NEEDLES) {
    const f = foldLaunchName(needle);
    if ((n + s).includes(f) || (s + n).includes(f)) return needle;
  }
  return null;
}

/** True when a non-rejected, non-failed launch already uses this name or symbol. */
export function isDuplicateLaunch(
  launches: LaunchProposal[],
  name: string,
  symbol: string,
): boolean {
  return launches.some(
    (l) =>
      l.status !== "rejected" &&
      l.status !== "failed" &&
      (l.symbol === symbol || l.name.trim().toLowerCase() === name.trim().toLowerCase()),
  );
}
