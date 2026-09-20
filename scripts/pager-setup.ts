import { LAURA_INTERN_ID, pagerGetProfile, pagerHolderSession, pagerModConfigured, pagerModStatus, pagerSaveProfile } from "@/lib/pager/client";

/**
 * One shot: sign LAURA into Pager with the swarm wallet, claim the username and set
 * Stonk Intern 1990 as her profile picture. Idempotent: re-running keeps the profile.
 * Then prints whether the moderator key is present (it is env only, never in the repo).
 *
 * Run: set -a; . shared/.env.local; set +a; npx tsx --tsconfig tsconfig.json scripts/pager-setup.ts
 */
async function main() {
  const session = await pagerHolderSession();
  console.log(`Signed in as ${session.wallet} (token good until ${new Date(session.exp).toISOString()})`);
  const { me } = await pagerGetProfile();
  const username = process.env.PAGER_USERNAME ?? me?.username ?? "LAURA";
  await pagerSaveProfile({
    username,
    pfp: { kind: "intern", id: LAURA_INTERN_ID },
    /* The account the swarm actually posts from, confirmed against
       account/verify_credentials (screen_name LAURA_DAIO, name "L.A.U.R.A").
       The brief's draft carried a different handle, which would have pointed
       the floor at someone else's profile. */
    contact: { x: "LAURA_DAIO", discord: "", telegram: "" },
    contactPublic: true,
    profilePublic: true,
  });
  const after = await pagerGetProfile();
  console.log(`Profile: @${after.me?.username} pfp=${JSON.stringify(after.me?.pfp)} level=${JSON.stringify(after.me?.level ?? null)}`);
  if (pagerModConfigured()) {
    const st = await pagerModStatus();
    console.log(`Moderator key OK: posts as "${st.mod.name}", ${st.bans.length} muted wallet(s)`);
  } else {
    console.log("PAGER_MOD_KEY not set: holder access works, moderation does not. Ask the operator for the key.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
