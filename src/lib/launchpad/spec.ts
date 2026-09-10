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
  postTaxBps: z.number().min(0).max(500),
  sellsEnabled: z.boolean(),
  bufferSecs: z.number().min(600).max(3600),
} as const;

/* Palette vocabulary, as the literal tuple zod's enum needs. This is the
   source of truth: art.ts types its palette map with these keys, so adding a
   palette on either side without the other is a compile error (no drift). */
export const ART_PALETTES = ["emerald", "amber", "crimson", "violet", "cyan", "gold", "ion", "aurora"] as const;

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
