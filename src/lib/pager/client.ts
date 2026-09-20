import { privateKeyToAccount } from "viem/accounts";

/**
 * StonkBrokers Pager client for the swarm.
 *
 * Two identities, deliberately separate:
 *  - HOLDER: the swarm wallet (SWARM_WALLET_PRIVATE_KEY) holds Stonk Intern 1990, so it signs in like
 *    any holder (EIP-191, no gas) and gets a 7 day bearer token. Everything a holder can do:
 *    profile (username, intern pfp, contact), General / Rooms, likes, replies, @mentions, DMs,
 *    job offers, the Work board, the notifications feed.
 *  - MODERATOR: the `x-pager-mod-key` header (PAGER_MOD_KEY, env only, never in this repo).
 *    Posts land as "LAURA - Moderator", can delete messages / rooms and mute wallets, and is
 *    REFUSED on every private room (DMs, note replies, job rooms). It has no profile, no feed.
 *
 * Base URL defaults to production; PAGER_BASE_URL overrides for previews.
 */

export const PAGER_BASE_URL = (process.env.PAGER_BASE_URL ?? "https://stonkbrokers.io").replace(/\/$/, "");
export const PAGER_CHAIN_ID = 4663;
/** LAURA's face on the floor. ownerOf(1990) == the swarm wallet (library/90-interns.md). */
export const LAURA_INTERN_ID = 1990;

export type PagerPfp = { kind: "broker" | "intern"; id: number };
export type PagerMessage = {
  id: string;
  wallet: string;
  username: string;
  pfp: PagerPfp | null;
  text: string;
  ts: number;
  brokerId?: number;
  mod?: boolean;
  likes?: string[];
  replyTo?: { id: string; wallet: string; username: string; text: string };
  anon?: boolean;
};
export type PagerThread = { id: string; title: string; wallet: string; username: string; createdAt: number; lastAt: number; count: number; mod?: boolean };
export type PagerNotif = {
  id: string;
  kind: "reply" | "mention" | "dm" | "notereply" | "job" | "thread" | "like";
  room: string;
  messageId: string;
  from: string;
  fromName: string;
  fromPfp: PagerPfp | null;
  preview: string;
  ts: number;
  brokerId?: number;
  jobId?: number;
  threadTitle?: string;
};
export type PagerSession = { token: string; exp: number; wallet: string };

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `pager ${res.status}`);
  return body;
}

function buildLoginMessage(p: { chainId: number; wallet: string; issuedAt: string; nonce: string }): string {
  // Must stay byte identical to apps/web/app/lib/pager.ts buildPagerLoginMessage on stonkbrokers.
  return [
    "Sign in to Pager, the StonkBrokers messenger.",
    "This signature costs no gas and moves no funds.",
    `chain: ${p.chainId}`,
    `wallet: ${p.wallet.toLowerCase()}`,
    `issued: ${p.issuedAt}`,
    `nonce: ${p.nonce}`,
  ].join("\n");
}

/* ?? holder session (the swarm wallet) ????????????????????????????????? */

let cached: PagerSession | null = null;

/** Sign in with the swarm wallet. Cached until an hour before expiry. */
export async function pagerHolderSession(): Promise<PagerSession> {
  if (cached && cached.exp - Date.now() > 3_600_000) return cached;
  const key = process.env.SWARM_WALLET_PRIVATE_KEY;
  if (!key) throw new Error("No wallet configured (set SWARM_WALLET_PRIVATE_KEY)");
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = account.address.toLowerCase();
  const issuedAt = new Date().toISOString();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const signature = await account.signMessage({ message: buildLoginMessage({ chainId: PAGER_CHAIN_ID, wallet, issuedAt, nonce }) });
  const r = await json<PagerSession>(
    await fetch(`${PAGER_BASE_URL}/api/pager/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, issuedAt, nonce, signature }),
    }),
  );
  cached = r;
  return r;
}

async function holderHeaders(): Promise<Record<string, string>> {
  const s = await pagerHolderSession();
  return { "content-type": "application/json", authorization: `Bearer ${s.token}` };
}

export async function pagerGetProfile(): Promise<{ me: { wallet: string; username: string; pfp: PagerPfp | null; level?: unknown } | null }> {
  return json(await fetch(`${PAGER_BASE_URL}/api/pager/profile`, { headers: await holderHeaders(), cache: "no-store" }));
}

/** Save the holder profile. `pfp` must be an NFT the swarm wallet holds (checked on chain). */
export async function pagerSaveProfile(p: {
  username: string;
  pfp: PagerPfp | null;
  contact?: { x?: string; discord?: string; telegram?: string };
  contactPublic?: boolean;
  profilePublic?: boolean;
}): Promise<unknown> {
  return json(
    await fetch(`${PAGER_BASE_URL}/api/pager/profile`, {
      method: "POST",
      headers: await holderHeaders(),
      body: JSON.stringify({ contact: { x: "", discord: "", telegram: "" }, contactPublic: true, profilePublic: true, ...p, brokerIds: [] }),
    }),
  );
}

export async function pagerReadRoom(room: string, since = 0): Promise<{ messages: PagerMessage[]; meta: { count: number; lastAt: number } }> {
  return json(await fetch(`${PAGER_BASE_URL}/api/pager/rooms/${encodeURIComponent(room)}?since=${since}`, { headers: await holderHeaders(), cache: "no-store" }));
}

/** Post as the holder (LAURA's own intern faced profile). `replyToId` quotes a message. */
export async function pagerPostAsHolder(room: string, text: string, replyToId?: string): Promise<PagerMessage> {
  const r = await json<{ message: PagerMessage }>(
    await fetch(`${PAGER_BASE_URL}/api/pager/rooms/${encodeURIComponent(room)}`, {
      method: "POST",
      headers: await holderHeaders(),
      body: JSON.stringify({ text, ...(replyToId ? { replyTo: { id: replyToId } } : {}) }),
    }),
  );
  return r.message;
}

export async function pagerLike(room: string, id: string): Promise<{ likes: string[]; liked: boolean }> {
  return json(await fetch(`${PAGER_BASE_URL}/api/pager/rooms/${encodeURIComponent(room)}/like`, { method: "POST", headers: await holderHeaders(), body: JSON.stringify({ id }) }));
}

/** Everything directed at LAURA: replies, mentions, DMs, job rooms, likes. Newest first. */
export async function pagerNotifications(since = 0): Promise<PagerNotif[]> {
  const r = await json<{ notifs: PagerNotif[] }>(await fetch(`${PAGER_BASE_URL}/api/pager/notifications?since=${since}`, { headers: await holderHeaders(), cache: "no-store" }));
  return r.notifs;
}

/** Open (or reuse) a private DM with another holder. Returns the room id (dm:...). */
export async function pagerOpenDm(peer: string): Promise<string> {
  const r = await json<{ room: string }>(await fetch(`${PAGER_BASE_URL}/api/pager/dms`, { method: "POST", headers: await holderHeaders(), body: JSON.stringify({ peer }) }));
  return r.room;
}

/* ?? moderator (header key, env only) ?????????????????????????????????? */

function modHeaders(): Record<string, string> {
  const key = process.env.PAGER_MOD_KEY;
  if (!key) throw new Error("PAGER_MOD_KEY is not set (moderator actions need it; ask the operator)");
  return { "content-type": "application/json", "x-pager-mod-key": key };
}

export const pagerModConfigured = (): boolean => Boolean(process.env.PAGER_MOD_KEY);

export async function pagerModReadRoom(room: string, since = 0): Promise<{ messages: PagerMessage[]; meta: { count: number; lastAt: number } }> {
  return json(await fetch(`${PAGER_BASE_URL}/api/pager/rooms/${encodeURIComponent(room)}?since=${since}`, { headers: modHeaders(), cache: "no-store" }));
}

export async function pagerModThreads(): Promise<PagerThread[]> {
  const r = await json<{ threads: PagerThread[] }>(await fetch(`${PAGER_BASE_URL}/api/pager/forum`, { headers: modHeaders(), cache: "no-store" }));
  return r.threads;
}

/** Post as "LAURA - Moderator" (mod chip, no cooldowns). Public rooms only. */
export async function pagerModPost(room: string, text: string): Promise<PagerMessage> {
  const r = await json<{ message: PagerMessage }>(
    await fetch(`${PAGER_BASE_URL}/api/pager/rooms/${encodeURIComponent(room)}`, { method: "POST", headers: modHeaders(), body: JSON.stringify({ text }) }),
  );
  return r.message;
}

export async function pagerModDeleteMessage(room: string, id: string): Promise<void> {
  await json(await fetch(`${PAGER_BASE_URL}/api/pager/mod`, { method: "POST", headers: modHeaders(), body: JSON.stringify({ action: "delete_message", room, id }) }));
}

export async function pagerModDeleteThread(threadId: string): Promise<void> {
  await json(await fetch(`${PAGER_BASE_URL}/api/pager/mod`, { method: "POST", headers: modHeaders(), body: JSON.stringify({ action: "delete_thread", threadId }) }));
}

export async function pagerModMute(wallet: string, muted: boolean): Promise<string[]> {
  const r = await json<{ bans: string[] }>(
    await fetch(`${PAGER_BASE_URL}/api/pager/mod`, { method: "POST", headers: modHeaders(), body: JSON.stringify({ action: muted ? "ban" : "unban", wallet }) }),
  );
  return r.bans;
}

export async function pagerModStatus(): Promise<{ mod: { wallet: string; name: string }; bans: string[] }> {
  return json(await fetch(`${PAGER_BASE_URL}/api/pager/mod`, { headers: modHeaders(), cache: "no-store" }));
}
