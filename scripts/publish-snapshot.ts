import { maybePublishSnapshot } from "@/lib/viewer/publish";

/**
 * One-shot snapshot push to the public viewer. Requires VIEWER_PUBLISH_URL and
 * SNAPSHOT_PUBLISH_SECRET in the environment (.env.local is not auto-loaded
 * outside Next; source it first or run via the dev server's scheduler).
 *
 *   set -a; . ./.env.local; set +a
 *   npx tsx --tsconfig tsconfig.json scripts/publish-snapshot.ts
 */
maybePublishSnapshot({ force: true })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
