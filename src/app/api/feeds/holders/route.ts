import type { NextRequest } from "next/server";
import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";
import { DEFAULT_SETTINGS } from "@/lib/swarm/roster";

/**
 * Holder counters feed - token holder count and lifetime transfer count for
 * $STONKBROKER (default) or any Robinhood Chain token passed as ?token=0x...
 *
 * Built for the price lever debate in the cafe bar: holder count is the one
 * proxy the swarm named that content can plausibly move and that no agent
 * can inflate alone. This route serves the CURRENT counters; deltas are the
 * caller's job (the VM snapshots each cycle, so cycle over cycle deltas fall
 * out of the metrics history for free). The ?token= form also serves the
 * launch health definition: holders on a pad token beyond the swarm wallet
 * is one of the three proposed skip conditions.
 *
 * Source (public, unkeyed): the broker tools Blockscout proxy (the direct
 * explorer 403s datacenter traffic), tokens/{address}/counters.
 */

export const dynamic = "force-dynamic";

const BS_PROXY = "https://bs-proxy-production.up.railway.app/api/v2";
const STONKBROKER = DEFAULT_SETTINGS.tokenAddress.toLowerCase();

/** Cap the set of distinct addresses this lambda will cache - an open param
 * must never become an unbounded memory map. STONKBROKER never counts
 * against the cap. */
const MAX_TRACKED_ADDRESSES = 50;
const tracked = new Set<string>();

type Counters = { token_holders_count?: string; transfers_count?: string };

async function load(address: string) {
  const c = await getJson<Counters>(`${BS_PROXY}/tokens/${address}/counters`, 12_000);
  const holders = Number(c.token_holders_count ?? NaN);
  const transfers = Number(c.transfers_count ?? NaN);
  if (!Number.isFinite(holders)) throw new Error("counters missing holder count");
  return {
    ok: true,
    token: address,
    chain: "robinhood",
    holders,
    transfers: Number.isFinite(transfers) ? transfers : null,
  };
}

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("token") ?? STONKBROKER).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(raw)) return feedError("token must be a 0x address");

  if (raw !== STONKBROKER && !tracked.has(raw)) {
    if (tracked.size >= MAX_TRACKED_ADDRESSES)
      return feedError("tracked address budget exhausted; default token still served");
    tracked.add(raw);
  }

  try {
    const { data, stale, at } = await cached(`holders:${raw}`, 300_000, () => load(raw));
    return feedResponse({ ...data, stale, updatedAt: at }, 120);
  } catch (err) {
    return feedError(String(err));
  }
}
