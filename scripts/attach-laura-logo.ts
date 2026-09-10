import { loadState } from "@/lib/store";
import { getAccount } from "@/lib/launchpad/service";
import { generateLauraLogo } from "@/lib/launchpad/laura-logo";
import { attachTokenLogo, uploadTokenImage } from "@/lib/launchpad/images";

/**
 * Idempotently attaches LAURA's sentinel logo to whichever LAURA token is
 * currently marked deployed in state. Safe to re-run: the launcher simply
 * overwrites the logo for that token; a future relaunch gets fresh art from
 * the executor automatically. Reads state at runtime, never mutates it.
 *
 * Run: set -a; . .env.local; set +a; npx tsx --tsconfig tsconfig.json scripts/attach-laura-logo.ts
 */
async function main() {
  const state = await loadState();
  const laura = [...state.launches]
    .filter((l) => l.symbol === "LAURA" && l.status === "deployed" && l.tokenAddress)
    .sort((a, b) => (b.deployedAt ?? 0) - (a.deployedAt ?? 0))[0];
  if (!laura?.tokenAddress) {
    console.log("No deployed LAURA token in state; nothing to attach.");
    return;
  }
  const account = getAccount();
  if (!account) {
    console.log("Wallet not configured; skipping attach.");
    return;
  }
  console.log(`Attaching sentinel logo to LAURA token ${laura.tokenAddress} (launch ${laura.id})`);
  const bytes = await generateLauraLogo();
  console.log(`Logo rendered: ${bytes.length} bytes (cap 49152)`);
  const imageHash = await uploadTokenImage(bytes);
  console.log(`Uploaded: imageHash ${imageHash}`);
  await attachTokenLogo(account, laura.tokenAddress, imageHash);
  console.log("Logo attached on the launcher.");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
