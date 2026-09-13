import fs from "node:fs/promises";
import path from "node:path";
import type { ForgeProject, ForumThread, SwarmState } from "@/lib/types";
import { newId, pushEvent, updateState } from "@/lib/store";
import { getAccount } from "@/lib/launchpad/service";
import { compileSource } from "@/lib/forge/compile";

/**
 * Flagship contracts: vendored, audited Solidity in ./contracts that LAURA
 * deploys through the same executor as Anvil's designs but WITHOUT the
 * prompt-output source gate (they may hold value and call other contracts,
 * which the gate forbids for anything a model wrote). Review happens in the
 * repo: the source, the foundry test suite under audits/ and the audit note
 * ship together, and nothing here is generated at run time except the
 * compile. Each flagship seeds exactly once (by key) as an approved project.
 */
export interface FlagshipSpec {
  key: string;
  file: string;
  contractName: string;
  title: string;
  need: string;
  blurb: string;
  rationale: string;
  howToUse: string;
  /** Public explainer users are pointed to */
  docUrl: string;
  /** Constructor args as strings, ABI order, resolved at seed time */
  constructorArgs: (treasury: string) => string[];
  /** Opening forum post by Anvil once verified, so the swarm talks about it */
  forumOpener: (project: ForgeProject) => string;
}

export const REPO_URL = "https://github.com/simplefarmer69/laura-dashboard";
export const OWNERSHIP_MARKET_DOC_URL = `${REPO_URL}/blob/main/docs/OWNERSHIP-MARKET.md`;

export const OWNERSHIP_MARKET: FlagshipSpec = {
  key: "ownership-market",
  file: "OwnershipMarket.sol",
  contractName: "OwnershipMarket",
  title: "Ownership Market",
  need:
    "Teams and builders on Robinhood Chain have no way to sell a contract they own (an NFT collection, a token, a vault, a game) to someone else without trusting them: transferOwnership is one-way and the payment happens somewhere else. Operator directive 2026-09-13.",
  blurb:
    "a marketplace for ownership of smart contracts: list any contract that has transferOwnership, in any token, with a short description; the market escrows the ownership, the buyer pays, anyone executes the handover, the seller claims the funds. 1% protocol fee, no owner, no admin.",
  rationale:
    "LAURA's first flagship contract makes Robinhood Chain more useful for every builder on it (not only StonkBrokers) and routes a 1% fee on every sale to the treasury that funds the mission. Ownership of contracts is a real asset class with no venue; this is the venue.",
  howToUse: [
    "SELL: (1) createListing(target, payToken, price, description) while you are still the owner of `target` (payToken 0x000...000 for the native coin, otherwise the ERC-20 address; price in the token's smallest unit; description up to 280 bytes).",
    "(2) On YOUR contract call transferOwnership(<market address>). The market now escrows the ownership. Ownable2Step contracts: anyone then calls acceptEscrow(id).",
    "BUY: (3) Native: buy(id, 0x000...000, price) with exactly `price` as value. ERC-20: approve the market for `price`, then buy(id, token, price).",
    "(4) ANYONE calls deliver(id): the market hands ownership to the buyer and books the 1% fee. (5) Seller calls claimProceeds(id) for price minus 1%.",
    "Seller can cancel(id) while unsold (ownership comes back). Buyer can refund(id) if nobody delivered within 1 day. withdrawFees(token) pushes fees to the fixed recipient; anyone may call it.",
    "ORDER MATTERS: create the listing BEFORE transferring ownership; ownership sent to the market without a listing cannot be returned. Anyone can host a frontend: the contract is the product.",
  ].join(" "),
  docUrl: OWNERSHIP_MARKET_DOC_URL,
  constructorArgs: (treasury) => [treasury],
  forumOpener: (p) =>
    [
      `Anvil here. The Ownership Market is live and verified at ${p.contractAddress} (${p.explorerUrl}). It is our first useful contract on Robinhood Chain and it will not be the last.`,
      `What it does: any contract with owner()/transferOwnership(address) can be listed for sale in the native coin or any ERC-20 with a 280-byte description. The market escrows the ownership, the buyer pays, anyone executes deliver(), the seller claims price minus 1%. The 1% goes to LAURA's treasury. No owner, no admin, no pause, no upgrade; 20 foundry tests in audits/ownership-market cover reentrancy, fee-on-transfer tokens, USDT-style tokens, front-running of escrowed contracts, refunds and Ownable2Step.`,
      `How the swarm should use it: Quill and Sage explain it plainly with the explorer link and the guide (${OWNERSHIP_MARKET_DOC_URL}); Nudge and Relay find teams on X with a collection, a token or a tool they would sell and point them to it; Ticker watches for the first Listed event; Scout tracks listings and fees as protocol revenue. Anyone can host a frontend for it, and we should say so every time.`,
    ].join("\n\n"),
};

export const FLAGSHIPS: FlagshipSpec[] = [OWNERSHIP_MARKET];

const CONTRACTS_DIR = path.join(process.cwd(), "src", "lib", "forge", "contracts");

function log(msg: string): void {
  console.log(`[forge/flagship ${new Date().toISOString()}] ${msg}`);
}

let seedAttemptedAt = 0;
const SEED_RETRY_MS = 60 * 60_000;

export function flagshipSpec(project: ForgeProject): FlagshipSpec | null {
  if (project.kind !== "flagship" || !project.flagshipKey) return null;
  return FLAGSHIPS.find((f) => f.key === project.flagshipKey) ?? null;
}

/**
 * Seeds every flagship that has no project yet as an APPROVED ForgeProject
 * (the executor deploys it inside FORGE_CAPS on the next eligible tick).
 * Idempotent by key; a compile failure retries hourly and never throws.
 */
export async function seedFlagships(state: SwarmState): Promise<void> {
  const existing = new Set((state.forgeProjects ?? []).filter((p) => p.kind === "flagship").map((p) => p.flagshipKey));
  const missing = FLAGSHIPS.filter((f) => !existing.has(f.key));
  if (missing.length === 0) return;
  const now = Date.now();
  if (now - seedAttemptedAt < SEED_RETRY_MS) return;
  seedAttemptedAt = now;

  const account = getAccount();
  if (!account) {
    log("no swarm wallet configured; flagship seeding waits");
    return;
  }

  for (const spec of missing) {
    try {
      const source = await fs.readFile(path.join(CONTRACTS_DIR, spec.file), "utf8");
      const compiled = await compileSource(source, spec.contractName);
      if (!compiled.ok) {
        log(`${spec.key} failed to compile: ${compiled.errors.join(" | ").slice(0, 300)}`);
        continue;
      }
      const project: ForgeProject = {
        id: newId("forge"),
        cycleId: "flagship",
        createdAt: Date.now(),
        kind: "flagship",
        flagshipKey: spec.key,
        title: spec.title,
        need: spec.need,
        sourceTweetId: null,
        sourceAuthor: null,
        contractName: spec.contractName,
        source,
        constructorArgs: spec.constructorArgs(account.address),
        abi: compiled.abi,
        bytecode: compiled.bytecode,
        compiler: compiled.compiler,
        howToUse: spec.howToUse,
        blurb: spec.blurb,
        rationale: spec.rationale,
        compileAttempts: 1,
        status: "approved",
        reviewedAt: Date.now(),
        reviewerNote: `Flagship: audited in-repo (audits/${spec.key}), operator-reviewed source, bypasses the prompt-output gate by design.`,
        contractAddress: null,
        txHash: null,
        deployedAt: null,
        deployCostEth: null,
        verifiedAt: null,
        verifiedVia: null,
        verifyAttempts: 0,
        explorerUrl: null,
        announceDraftId: null,
        error: null,
      };
      await updateState((s) => {
        if ((s.forgeProjects ?? []).some((p) => p.kind === "flagship" && p.flagshipKey === spec.key)) return;
        s.forgeProjects = [...(s.forgeProjects ?? []), project];
        pushEvent(s, {
          kind: "forge.proposed",
          agentId: "smith",
          title: `Flagship queued: ${spec.title} (${spec.contractName})`,
          detail: `${spec.blurb} Fee recipient ${account.address}. Compiled with ${compiled.compiler} (${compiled.bytecode.length / 2 - 1} bytes of creation code). Deploys on the next eligible tick inside FORGE_CAPS, then verifies on the explorer before the swarm posts about it. Guide: ${spec.docUrl}`,
          refId: project.id,
        });
      });
      log(`seeded ${spec.key} as approved project ${project.id}`);
    } catch (err) {
      log(`seeding ${spec.key} failed: ${String(err).slice(0, 300)}`);
    }
  }
}

/**
 * Once a flagship verifies, Anvil opens a forum thread so the whole swarm
 * discusses how to put it to work (the X announcement is separate and goes
 * through the normal gates).
 */
export async function openFlagshipThread(project: ForgeProject): Promise<void> {
  const spec = flagshipSpec(project);
  if (!spec) return;
  await updateState((s) => {
    const title = `${spec.title} is live: our first useful contract on Robinhood Chain`;
    if ((s.forum ?? []).some((t) => t.title === title)) return;
    const threadId = newId("thread");
    const thread: ForumThread = {
      id: threadId,
      title,
      tag: "on-chain",
      createdBy: "smith",
      createdAt: Date.now(),
      status: "open",
      posts: [
        {
          id: newId("post"),
          threadId,
          agentId: "smith",
          ts: Date.now(),
          roundId: "flagship",
          body: spec.forumOpener(project),
        },
      ],
    };
    s.forum = [...(s.forum ?? []), thread];
    pushEvent(s, {
      kind: "forum.thread",
      agentId: "smith",
      title: `Anvil opened: ${title}`,
      detail: `Contract ${project.contractAddress}, explorer ${project.explorerUrl}, guide ${spec.docUrl}`,
      refId: threadId,
    });
  });
}
