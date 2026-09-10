import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * NFT trends feed - collection level intelligence on both chains LAURA
 * watches, read entirely from public unkeyed Blockscout v2 APIs (OpenSea
 * needs an API key, so it is deliberately not used here):
 *
 *   Robinhood Chain - via the broker tools Blockscout proxy (the direct
 *   explorer 403s datacenter traffic): the top ERC-721 collections by
 *   holders (position / infra NFTs filtered out) plus the StonkBrokers
 *   collection's own counters (holders + lifetime transfers).
 *
 *   Ethereum mainnet - eth.blockscout.com, a pinned blue chip set (BAYC,
 *   Pudgy Penguins, Azuki, Milady, Doodles, Moonbirds) as a market
 *   temperature read. Per address token lookups are unkeyed and reliable;
 *   the chain wide ranked list is not, hence the pinned set.
 */

export const dynamic = "force-dynamic";

const RH_BS = "https://bs-proxy-production.up.railway.app/api/v2";
const ETH_BS = "https://eth.blockscout.com/api/v2";
const BROKER_COLLECTION = "0x539CdD042c2f3d93EbC5BE7DfFf0c79F3B4fAbF0";

/** Position / infra NFTs that dominate the holder ranking but are not collections. */
const RH_DENY_SYMBOLS = new Set(["UNI-V4-POSM", "UNI-V3-POS", "UP-POS", "FEEB", "SLIP"]);

const ETH_BLUE_CHIPS: Array<{ address: string; label: string }> = [
  { address: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", label: "Bored Ape Yacht Club" },
  { address: "0xBd3531dA5CF5857e7CfAA92426877b022e612cf8", label: "Pudgy Penguins" },
  { address: "0xED5AF388653567Af2F388E6224dC7C4b3241C544", label: "Azuki" },
  { address: "0x5Af0D9827E0c53E4799BB226655A1de152A425a5", label: "Milady Maker" },
  { address: "0x8a90CAb2b38dba80c64b7734e58Ee1dB38B8992e", label: "Doodles" },
  { address: "0x23581767a106ae21c074b2276D25e5C3e136a68b", label: "Moonbirds" },
];

type BsToken = {
  address_hash?: string;
  name?: string | null;
  symbol?: string | null;
  holders_count?: string | null;
  total_supply?: string | null;
  type?: string;
};

export type NftCollection = {
  address: string;
  name: string;
  symbol: string;
  holders: number;
  supply: number | null;
};

export type NftTrendsData = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  robinhood: {
    broker: { holders: number; transfers: number; supply: number | null } | null;
    collections: NftCollection[];
  };
  ethereum: {
    collections: NftCollection[];
  };
};

function toCollection(t: BsToken): NftCollection | null {
  const address = t.address_hash;
  if (!address) return null;
  return {
    address,
    name: t.name ?? "Unknown",
    symbol: t.symbol ?? "",
    holders: Number(t.holders_count ?? 0) || 0,
    supply: t.total_supply != null ? Number(t.total_supply) || null : null,
  };
}

function isRealCollection(t: BsToken): boolean {
  const name = (t.name ?? "").toLowerCase();
  if (name.includes("position") || name.includes("fee beneficiary")) return false;
  if (t.symbol && RH_DENY_SYMBOLS.has(t.symbol)) return false;
  return true;
}

async function load(): Promise<NftTrendsData> {
  const [rhList, brokerInfo, brokerCounters, ...ethResults] = await Promise.all([
    getJson<{ items?: BsToken[] }>(`${RH_BS}/tokens?type=ERC-721`, 12_000).catch(() => null),
    getJson<BsToken>(`${RH_BS}/tokens/${BROKER_COLLECTION}`, 12_000).catch(() => null),
    getJson<{ transfers_count?: string; token_holders_count?: string }>(
      `${RH_BS}/tokens/${BROKER_COLLECTION}/counters`,
      12_000,
    ).catch(() => null),
    ...ETH_BLUE_CHIPS.map((c) =>
      getJson<BsToken>(`${ETH_BS}/tokens/${c.address}`, 12_000).catch(() => null),
    ),
  ]);

  const rhCollections = (rhList?.items ?? [])
    .filter(isRealCollection)
    .map(toCollection)
    .filter((c): c is NftCollection => c !== null)
    .slice(0, 8);

  const broker =
    brokerCounters || brokerInfo
      ? {
          holders: Number(brokerCounters?.token_holders_count ?? brokerInfo?.holders_count ?? 0) || 0,
          transfers: Number(brokerCounters?.transfers_count ?? 0) || 0,
          supply: brokerInfo?.total_supply != null ? Number(brokerInfo.total_supply) || null : null,
        }
      : null;

  const ethCollections = ethResults
    .map((t, i) => {
      if (!t) return null;
      const c = toCollection({ ...t, address_hash: t.address_hash ?? ETH_BLUE_CHIPS[i].address });
      if (c && ETH_BLUE_CHIPS[i]) c.name = ETH_BLUE_CHIPS[i].label;
      return c;
    })
    .filter((c): c is NftCollection => c !== null);

  /* Do not publish a snapshot with BOTH lanes empty - let cached() keep the
     last good payload instead (the never serve empty rule). */
  if (rhCollections.length === 0 && ethCollections.length === 0 && !broker) {
    throw new Error("all Blockscout sources unavailable");
  }

  return {
    ok: true,
    updatedAt: Date.now(),
    stale: false,
    robinhood: { broker, collections: rhCollections },
    ethereum: { collections: ethCollections },
  };
}

export async function GET() {
  try {
    const { data, stale, at } = await cached("nft-trends", 300_000, load);
    return feedResponse({ ...data, stale, updatedAt: at }, 120);
  } catch (err) {
    return feedError(String(err));
  }
}
