import { loadState } from "@/lib/store";
import { getAccount } from "@/lib/launchpad/service";
import { attachTokenProfile, profileLinksFromEnv } from "@/lib/launchpad/images";

/**
 * Backfills community links onto every deployed LAURA token's launcher
 * profile (creator-signed; the swarm wallet is the creator). Idempotent —
 * the launcher overwrites the profile for the token. Also serves as the live
 * verification that the signed token-profile flow works with just a website
 * field while TOKEN_PROFILE_X / TOKEN_PROFILE_TELEGRAM stay unset.
 *
 * Run: set -a; . .env.local; set +a; npx tsx --tsconfig tsconfig.json scripts/attach-token-profiles.ts
 */
async function main() {
  const state = await loadState();
  const deployed = state.launches.filter((l) => l.status === "deployed" && l.tokenAddress);
  if (deployed.length === 0) {
    console.log("No deployed tokens in state; nothing to attach.");
    return;
  }
  const account = getAccount();
  if (!account) {
    console.log("Wallet not configured; skipping.");
    return;
  }
  const links = profileLinksFromEnv();
  if (!links) {
    console.log("No profile links resolved; skipping.");
    return;
  }
  console.log(`Links: x="${links.x}" website="${links.website}" telegram="${links.telegram}"`);
  for (const l of deployed) {
    try {
      await attachTokenProfile(account, l.tokenAddress!, links);
      console.log(`OK   ${l.name} ($${l.symbol}) ${l.tokenAddress}`);
    } catch (err) {
      console.log(`FAIL ${l.name} ($${l.symbol}) ${l.tokenAddress}: ${String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
