import type { PrivateKeyAccount } from "viem/accounts";
import { LAUNCHPAD } from "@/lib/launchpad/contracts";

/**
 * Launcher image + metadata surface, reverse-engineered from the official
 * stonkbrokers.cash client bundle:
 *  - POST /api/launcher/token-image      raw image bytes -> { ok, imageHash }
 *  - POST /api/safe-launch/token-logo    creator-signed logo attach
 *  - POST /api/safe-launch/token-profile creator-signed X/website/telegram links
 * Only the launch creator's wallet signature is accepted, so these run
 * with the swarm wallet after a deploy confirms.
 */

const SITE = "https://www.stonkbrokers.cash";

/** Uploads logo bytes; returns the content-addressed imageHash. Retries like the site client. */
export async function uploadTokenImage(bytes: Buffer, contentType = "image/webp"): Promise<string> {
  let lastError = "Logo upload failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200 * attempt));
    let res: Response;
    try {
      res = await fetch(`${SITE}/api/launcher/token-image`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (err) {
      lastError = `Logo upload failed (network): ${String(err)}`;
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; imageHash?: string; error?: string };
    if (res.ok && json.ok && json.imageHash) return json.imageHash;
    lastError = json.error ?? `Logo upload failed (HTTP ${res.status})`;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
  }
  throw new Error(lastError);
}

/** Attaches an uploaded image as the token's logo. Signature format matches the site exactly. */
export async function attachTokenLogo(
  account: PrivateKeyAccount,
  token: string,
  imageHash: string,
): Promise<void> {
  const signedAt = new Date().toISOString();
  const message = [
    "StonkBrokers Safe Launch logo",
    `chain: ${LAUNCHPAD.chainId}`,
    `token: ${token.toLowerCase()}`,
    `image: ${imageHash.toLowerCase()}`,
    `signed at: ${signedAt}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  const res = await fetch(`${SITE}/api/safe-launch/token-logo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, imageHash, signedAt, signature }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !json.ok) throw new Error(json.error ?? `Logo attach failed (HTTP ${res.status})`);
}

export interface TokenProfileLinks {
  x: string;
  website: string;
  telegram: string;
}

/** Community links come from env so every LAURA token points home consistently. */
export function profileLinksFromEnv(): TokenProfileLinks | null {
  const x = process.env.TOKEN_PROFILE_X ?? "";
  const website = process.env.TOKEN_PROFILE_WEBSITE ?? "";
  const telegram = process.env.TOKEN_PROFILE_TELEGRAM ?? "";
  if (!x && !website && !telegram) return null;
  return { x, website, telegram };
}

/** Attaches X/website/telegram links to a deployed token, creator-signed. */
export async function attachTokenProfile(
  account: PrivateKeyAccount,
  token: string,
  links: TokenProfileLinks,
): Promise<void> {
  const signedAt = new Date().toISOString();
  const message = [
    "StonkBrokers Safe Launch profile",
    `chain: ${LAUNCHPAD.chainId}`,
    `token: ${token.toLowerCase()}`,
    `x: ${links.x}`,
    `website: ${links.website}`,
    `telegram: ${links.telegram}`,
    `signed at: ${signedAt}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  const res = await fetch(`${SITE}/api/safe-launch/token-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...links, signedAt, signature }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !json.ok) throw new Error(json.error ?? `Profile attach failed (HTTP ${res.status})`);
}
