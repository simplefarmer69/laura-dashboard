import { z } from "zod";
import { ART_MOTIFS, ART_STYLES } from "@/lib/launchpad/art";
import { ART_PALETTES, RESERVED_LAUNCH_NEEDLES } from "@/lib/launchpad/spec";
import { missionDigest } from "@/lib/mission-status";
import { metricsDigest } from "@/lib/swarm/context";
import { LAUNCH_TEXT_BUDGET, LAUNCH_TEXT_SCHEMA_MAX, type CycleContext } from "@/lib/swarm/tasks";
import { DIRECT_LAUNCH_CAPS, PONS_LAUNCH_FEE_ETH } from "@/lib/direct-launch/caps";
import type { DirectLaunch, LaunchProposal } from "@/lib/types";

/**
 * Mint's design surface for launches outside the Stonklauncher. One schema
 * for both venues; the venue decides which fields the executor reads. The
 * bounds here are the code's, not the model's: directSpecProblem() rejects
 * what the contract or the Pons factory would refuse so a bad spec never
 * reaches the queue.
 */
export const directLaunchSchema = z.object({
  launch: z
    .object({
      venue: z
        .enum(["direct", "pons"])
        .describe("direct: LAURA's own tax token with the whole supply seeded as a single sided vDEX position. pons: a Pons V2 bonding curve launch (fixed 1B supply, graduates to a pool at 4.2 ETH)."),
      name: z.string().min(3).max(48),
      symbol: z.string().min(2).max(10).regex(/^[A-Z0-9]+$/),
      /** direct only */
      supplyTokens: z.number().min(1_000_000).max(1e12).describe("Whole tokens, direct venue only (Pons fixes 1,000,000,000)."),
      startMcapUsd: z.number().min(500).max(200_000).describe("direct: the pool opens at this market cap."),
      rangeTopMcapUsd: z.number().min(10_000).max(50_000_000).describe("direct: the single sided range runs from the start up to this market cap; at least 4x the start."),
      startTaxBps: z.number().int().min(0).max(5000).describe("direct: buy tax at the open, bps."),
      floorTaxBps: z.number().int().min(0).max(500).describe("direct: buy tax after the decay, bps."),
      decayBpsPerMinute: z.number().int().min(0).max(1000).describe("direct: bps the buy tax loses each minute; the window (start minus floor over decay) must be 5 to 180 minutes."),
      holderShareBps: z.number().int().min(0).max(10_000).describe("direct: share of each tax paid to holders as claimable rewards, bps of the tax."),
      burnShareBps: z.number().int().min(0).max(5000).describe("direct: share of each tax burned, bps of the tax. holders + burn <= 10000; the rest is LAURA's treasury share."),
      rewardMode: z.enum(["dividend", "diamond"]).describe("direct: dividend keeps rewards across transfers; diamond forfeits a wallet's unclaimed rewards to everyone else when it sends or sells."),
      creatorTaxBps: z.number().int().min(0).max(1000).describe("pons: creator tax on every curve trade, paid to LAURA's wallet (factory ceiling 1000)."),
      devBuyEth: z.number().min(0).max(DIRECT_LAUNCH_CAPS.maxDevBuyEth).describe(`pons: LAURA's opening buy in ETH right after the launch, 0 for none (cap ${DIRECT_LAUNCH_CAPS.maxDevBuyEth}).`),
      buybackEnabled: z.boolean().describe("pons: opt the launch into the protocol's buyback and lock."),
      concept: z.string().max(LAUNCH_TEXT_SCHEMA_MAX),
      rationale: z.string().max(LAUNCH_TEXT_SCHEMA_MAX),
      message: z.string().min(10).max(500).describe("The one statement this launch makes, in LAURA's voice, to the people who will see it appear. Also the token description on Pons."),
      artMotif: z.string().min(2).max(80).describe(`Visual motif for the logo, e.g. ${ART_MOTIFS.join(", ")}`),
      artPalette: z.enum(ART_PALETTES),
      artStyle: z.enum(ART_STYLES),
      imageQuery: z.string().min(3).max(120).describe("Concrete visual search phrase for the logo image."),
    })
    .nullable(),
  skipReason: z.string().max(300).nullable(),
});

export type DirectLaunchOut = z.infer<typeof directLaunchSchema>;
export type DirectLaunchSpec = NonNullable<DirectLaunchOut["launch"]>;

/** Returns why the contract or the Pons factory would refuse this spec, or null when it is sound. */
export function directSpecProblem(spec: DirectLaunchSpec): string | null {
  if (spec.venue === "direct") {
    if (spec.rangeTopMcapUsd < spec.startMcapUsd * 4) return "rangeTopMcapUsd must be at least 4x startMcapUsd";
    if (spec.floorTaxBps > spec.startTaxBps) return "floorTaxBps above startTaxBps";
    if (spec.startTaxBps > spec.floorTaxBps) {
      if (spec.decayBpsPerMinute <= 0) return "a decaying tax needs decayBpsPerMinute > 0";
      const windowMin = (spec.startTaxBps - spec.floorTaxBps) / spec.decayBpsPerMinute;
      if (windowMin < 5 || windowMin > 180) return `tax decay window is ${windowMin.toFixed(1)} minutes; it must be 5 to 180`;
    }
    if (spec.holderShareBps + spec.burnShareBps > 10_000) return "holderShareBps + burnShareBps over 10000";
    if (spec.startTaxBps === 0 && spec.floorTaxBps === 0) return "a direct launch with no tax has no rewards to speak of; use a tax or skip";
    return null;
  }
  if (spec.creatorTaxBps > 1000) return "Pons creator tax ceiling is 1000 bps";
  if (spec.devBuyEth > DIRECT_LAUNCH_CAPS.maxDevBuyEth) return `opening buy over the ${DIRECT_LAUNCH_CAPS.maxDevBuyEth} ETH cap`;
  return null;
}

/** True when a live or queued launch on EITHER rail already uses the name or symbol. */
export function isDuplicateAcrossRails(launches: LaunchProposal[], direct: DirectLaunch[], name: string, symbol: string): boolean {
  const n = name.trim().toLowerCase();
  const live = (s: { status: string }) => s.status !== "rejected" && s.status !== "failed";
  return launches.some((l) => live(l) && (l.symbol === symbol || l.name.trim().toLowerCase() === n)) || direct.some((l) => live(l) && (l.symbol === symbol || l.name.trim().toLowerCase() === n));
}

/** What LAURA has launched on these rails so far, for the prompt. */
export function directLaunchesDigest(direct: DirectLaunch[], limit = 8): string {
  const all = direct.filter((l) => l.status !== "rejected" && l.status !== "failed");
  if (all.length === 0) return "Nothing yet on these rails.";
  return all
    .slice(-limit)
    .map((l) => {
      const when = new Date(l.deployedAt ?? l.createdAt).toISOString().slice(0, 10);
      const econ =
        l.venue === "direct"
          ? `tax ${l.startTaxBps}->${l.floorTaxBps} bps, holders ${l.holderShareBps} burn ${l.burnShareBps} (${l.rewardMode}), mcap $${l.startMcapUsd.toLocaleString()} to $${l.rangeTopMcapUsd.toLocaleString()}`
          : `creator tax ${l.creatorTaxBps} bps, opening buy ${l.devBuyEth} ETH`;
      return `- ${when} · ${l.venue} · ${l.name} ($${l.symbol}) [${l.status}] ${econ}: ${l.message}`;
    })
    .join("\n");
}

export function directLaunchPrompt(input: {
  ctx: CycleContext;
  spoken: string;
  padSpoken: string;
  capacity: string;
  ponsOpen: boolean;
  ponsReason: string;
  ethUsd: number | null;
}): string {
  const { ctx } = input;
  return [
    `MISSION\n${missionDigest(ctx.mission)}`,
    `METRICS\n${metricsDigest(ctx.metrics)}`,
    `LIVE INTERNET INTEL\n${ctx.intel}`,
    `WORLD FEEDS\n${ctx.world}`,
    `${ctx.xVoices}`,
    `YOUR SKILLS (operating procedures; follow them)\n${ctx.skills.mint ?? "None."}`,
    `LIBRARY (durable build knowledge; trust it)\n${ctx.library}`,
    `THIS IS YOUR DIRECT LAUNCH TURN (operator directive 2026-10-02: LAURA may "simply launch tokens including tax tokens with interesting airdrop rewards features from the taxes, launching directly on chain and seeding single sided LP outside of the Stonklauncher, as well as tokens on Pons"). Mint designs a Stonklauncher launch every cycle; every few hours it also gets THIS turn to design ONE launch on the two rails below, or return launch: null with a skipReason. These rails are for designs the pads cannot express. Do not move a pad concept here; bring something the tax mechanics or the Pons curve make possible.`,
    `RAIL 1, DIRECT (venue "direct"): LAURA deploys her own token contract (LauraTaxToken, fixed code, verified source), opens its vDEX concentrated liquidity pool against WETH at startMcapUsd, seeds the WHOLE supply as a single sided position from startMcapUsd up to rangeTopMcapUsd (no ETH side; the first buyer sets the first price), marks the pool and burns the admin key. There is no graduation and no curve: it trades on the vDEX from the first second.
  TAX: a BUY tax only (sells are never taxed; a concentrated liquidity pool rejects tokens that take a cut on the way in, so this is physics, not a choice). It starts at startTaxBps and loses decayBpsPerMinute every minute until floorTaxBps; the window must be 5 to 180 minutes. The tax is paid in the token and split three ways by bps of the tax: holderShareBps to holder rewards, burnShareBps burned, the remainder to LAURA's wallet.
  REWARDS (the airdrop): holder rewards accrue pro rata to every wallet that is not the pool, claimable any time with claim(), and anyone can push everyone's rewards out with claimFor(list): LAURA will do that herself for the top holders, so the airdrop is real and periodic. rewardMode "dividend" keeps a wallet's unclaimed rewards across transfers. rewardMode "diamond" forfeits a wallet's unclaimed rewards to every other holder the moment it sends or sells: a reward for staying. The very first buy's holder share goes to the treasury (nobody to reward yet). Explain the mechanic in the message in the token's own words; an unexplained heavy tax reads as a rug signal.
  SCALE: startMcapUsd $500 to $200,000; rangeTopMcapUsd at least 4x the start. The whole supply sits in the range, so a tight range is deep liquidity and a wide range is a long runway. ${input.ethUsd ? `ETH is $${input.ethUsd.toFixed(0)} right now.` : ""}`,
    `RAIL 2, PONS (venue "pons"): ponsfamily.com's V2 launch factory on Robinhood Chain. Facts read live: ${input.ponsOpen ? "OPEN for LAURA's wallet" : `CLOSED (${input.ponsReason}); do not pick pons this turn`}. Fixed supply 1,000,000,000; the curve charges a 1% protocol fee plus your creatorTaxBps (0 to 1000) on every trade, paid straight to LAURA's wallet; the curve graduates into a pool at 4.2 ETH of buys; launch fee ${PONS_LAUNCH_FEE_ETH} ETH. LAURA is exempt from the snipe tax on her own launch, so an opening buy (devBuyEth, 0 to ${DIRECT_LAUNCH_CAPS.maxDevBuyEth} ETH) is clean; 0 is fine and the default stance (LAURA does not pump her own tokens). buybackEnabled true opts the launch into the protocol's buyback and lock. The message becomes the token description on the Pons page.`,
    `CAPS (code enforced; a spec that exceeds them is dropped, not trimmed)\n${input.capacity}`,
    `WHAT LAURA HAS LAUNCHED ON THESE RAILS\n${input.spoken}`,
    `WHAT LAURA HAS SAID THROUGH PAD LAUNCHES (never repeat a statement or reuse name material)\n${input.padSpoken}`,
    `RULES. Names and symbols original and non deceptive, never a live token's, never a person's or a project's name, never the operator's; never a name containing ${RESERVED_LAUNCH_NEEDLES.map((n) => `"${n}"`).join(", ")}. Every launch carries a message; a launch with nothing to say is spam, so skip. Design the tax and the reward as part of the message. No return promises, no gambling vocabulary, no "AI" disclosures, no sign off, no em dashes. LENGTH: concept at most ${LAUNCH_TEXT_BUDGET} characters, rationale at most ${LAUNCH_TEXT_BUDGET}, message at most 400. Fill imageQuery with a concrete visual phrase, and pick artMotif (${ART_MOTIFS.join(", ")}), artPalette (${ART_PALETTES.join(", ")}), artStyle (${ART_STYLES.join(", ")}). For a pons launch still fill the direct fields with sane values (they are ignored). Skip when the queue is at its limit, when the window is shut for more than six hours, or when nothing distinct is worth saying.`,
  ].join("\n\n");
}

export function directLaunchMock(ctx: CycleContext, reason: string | null): DirectLaunchOut {
  if (reason) return { launch: null, skipReason: reason };
  if (ctx.llmProvider !== "mock") {
    return { launch: null, skipReason: "LLM direct launch output failed schema validation twice; no fallback spec is queued in place of a real design" };
  }
  return {
    launch: {
      venue: "direct",
      name: "Standing Wave",
      symbol: "WAVE",
      supplyTokens: 1_000_000_000,
      startMcapUsd: 4000,
      rangeTopMcapUsd: 400_000,
      startTaxBps: 2000,
      floorTaxBps: 200,
      decayBpsPerMinute: 100,
      holderShareBps: 6000,
      burnShareBps: 1000,
      rewardMode: "diamond",
      creatorTaxBps: 0,
      devBuyEth: 0,
      buybackEnabled: false,
      concept: "A deterministic fallback design for keyless runs: a buy taxed token whose rewards flow to the wallets that stay.",
      rationale: "Fallback spec (no LLM key).",
      message: "Buy tax starts at twenty percent and falls to two over eighteen minutes. Sixty percent of every tax goes to holders who stay; sell and your unclaimed share goes to the rest.",
      artMotif: "wave",
      artPalette: "cyan",
      artStyle: "minimal",
      imageQuery: "standing wave in a glass tank",
    },
    skipReason: null,
  };
}
