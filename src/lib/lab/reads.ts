import { createPublicClient, http, type Address, type PublicClient } from "viem";
import {
  ERC20_ABI,
  EXPLORER_URL,
  LAB_CHAIN,
  MARKET_ABI,
  MARKET_ADDRESS,
  OWNABLE_ABI,
  PAYMENT_PRESETS,
  REGISTRY_ABI,
  REGISTRY_ADDRESS_FALLBACK,
  STATUS_BY_CODE,
  ZERO_ADDRESS,
  type Listing,
} from "@/lib/lab/contracts";
import { parseMetadata, type ListingMetadata } from "@/lib/lab/metadata";

let client: PublicClient | null = null;

export function labClient(): PublicClient {
  client ??= createPublicClient({ chain: LAB_CHAIN, transport: http(LAB_CHAIN.rpcUrls.default.http[0], { timeout: 15_000, batch: true }) });
  return client;
}

/**
 * The registry address comes from LAURA's own contract feed once the swarm
 * has deployed it (flagship key "lab-registry"), so this frontend needs no
 * redeploy when it lands. Anyone hosting a copy can pin it in contracts.ts.
 */
export async function discoverRegistryAddress(): Promise<Address | null> {
  if (REGISTRY_ADDRESS_FALLBACK) return REGISTRY_ADDRESS_FALLBACK;
  try {
    const res = await fetch("/api/forge", { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      projects?: Array<{ kind: string; flagshipKey: string | null; status: string; contractAddress: string | null }>;
    };
    const p = (json.projects ?? []).find(
      (x) => x.kind === "flagship" && x.flagshipKey === "lab-registry" && (x.status === "verified" || x.status === "deployed") && x.contractAddress,
    );
    return (p?.contractAddress as Address | undefined) ?? null;
  } catch {
    return null;
  }
}

type RawListing = {
  target: Address;
  seller: Address;
  buyer: Address;
  payToken: Address;
  price: bigint;
  paid: bigint;
  createdAt: bigint;
  soldAt: bigint;
  status: number;
  proceedsClaimed: boolean;
  description: string;
};

function toListing(id: number, r: RawListing, escrowed: boolean): Listing {
  return {
    id,
    target: r.target,
    seller: r.seller,
    buyer: r.buyer,
    payToken: r.payToken,
    price: r.price,
    paid: r.paid,
    createdAt: Number(r.createdAt),
    soldAt: Number(r.soldAt),
    status: STATUS_BY_CODE[r.status] ?? "none",
    proceedsClaimed: r.proceedsClaimed,
    description: r.description,
    escrowed,
  };
}

/** Every listing on the market, newest first, with the live escrow flag. */
export async function fetchListings(): Promise<Listing[]> {
  const c = labClient();
  const count = Number(await c.readContract({ address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "listingCount" }));
  if (count === 0) return [];
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const results = await c.multicall({
    allowFailure: true,
    contracts: ids.flatMap((id) => [
      { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "getListing", args: [BigInt(id)] } as const,
      { address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "isEscrowed", args: [BigInt(id)] } as const,
    ]),
  });
  const out: Listing[] = [];
  for (let i = 0; i < ids.length; i++) {
    const l = results[i * 2];
    const e = results[i * 2 + 1];
    if (l.status !== "success") continue;
    out.push(toListing(ids[i], l.result as unknown as RawListing, e.status === "success" ? Boolean(e.result) : false));
  }
  return out.reverse();
}

export async function fetchListing(id: number): Promise<Listing | null> {
  const c = labClient();
  const [l, e] = await Promise.all([
    c.readContract({ address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "getListing", args: [BigInt(id)] }),
    c.readContract({ address: MARKET_ADDRESS, abi: MARKET_ABI, functionName: "isEscrowed", args: [BigInt(id)] }),
  ]);
  const raw = l as unknown as RawListing;
  if (raw.seller === ZERO_ADDRESS) return null;
  return toListing(id, raw, Boolean(e));
}

export interface MetadataRecord {
  meta: ListingMetadata;
  raw: string;
  ok: boolean;
  setBy: Address;
  updatedAt: number;
}

/** Metadata for listing ids 1..maxId from the registry; ids without a record map to nothing. */
export async function fetchMetadata(registry: Address, maxId: number): Promise<Map<number, MetadataRecord>> {
  const out = new Map<number, MetadataRecord>();
  if (maxId === 0) return out;
  const c = labClient();
  const rows = (await c.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "getMetadataBatch",
    args: [1n, BigInt(maxId)],
  })) as ReadonlyArray<{ metadata: string; setBy: Address; updatedAt: bigint }>;
  rows.forEach((r, i) => {
    if (!r.metadata) return;
    const parsed = parseMetadata(r.metadata);
    out.set(i + 1, { meta: parsed.meta, raw: r.metadata, ok: parsed.ok, setBy: r.setBy, updatedAt: Number(r.updatedAt) });
  });
  return out;
}

export interface TargetInfo {
  address: Address;
  isContract: boolean;
  /** owner() as reported by the target; null when the call fails (not Ownable). */
  owner: Address | null;
  /** pendingOwner() when the target exposes it (Ownable2Step), else null. */
  pendingOwner: Address | null;
  twoStep: boolean;
  /** Blockscout: verified source? null when the explorer could not be asked from the browser. */
  verified: boolean | null;
  name: string | null;
}

export async function fetchTargetInfo(address: Address): Promise<TargetInfo> {
  const c = labClient();
  const [code, ownerRes, pendingRes] = await Promise.all([
    c.getCode({ address }).catch(() => undefined),
    c.readContract({ address, abi: OWNABLE_ABI, functionName: "owner" }).then((v) => v as Address).catch(() => null),
    c.readContract({ address, abi: OWNABLE_ABI, functionName: "pendingOwner" }).then((v) => v as Address).catch(() => null),
  ]);
  let verified: boolean | null = null;
  let name: string | null = null;
  try {
    const res = await fetch(`${EXPLORER_URL}/api/v2/smart-contracts/${address}`, { headers: { accept: "application/json" } });
    if (res.status === 200) {
      const j = (await res.json()) as { is_verified?: boolean; is_partially_verified?: boolean; name?: string };
      verified = Boolean(j.is_verified || j.is_partially_verified);
      name = j.name ?? null;
    } else if (res.status === 404) {
      verified = false;
    }
  } catch {
    verified = null;
  }
  return {
    address,
    isContract: Boolean(code && code !== "0x"),
    owner: ownerRes,
    pendingOwner: pendingRes,
    twoStep: pendingRes !== null,
    verified,
    name,
  };
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  native: boolean;
}

const tokenCache = new Map<string, TokenInfo>();

export async function fetchTokenInfo(address: Address): Promise<TokenInfo> {
  const key = address.toLowerCase();
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const preset = PAYMENT_PRESETS.find((p) => p.address.toLowerCase() === key);
  let info: TokenInfo;
  if (address === ZERO_ADDRESS) info = { address, symbol: "ETH", decimals: 18, native: true };
  else if (preset) info = { address, symbol: preset.symbol, decimals: preset.decimals, native: false };
  else {
    const c = labClient();
    const [symbol, decimals] = await Promise.all([
      c.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "TOKEN"),
      c.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    ]);
    info = { address, symbol: String(symbol), decimals: Number(decimals), native: false };
  }
  tokenCache.set(key, info);
  return info;
}

export async function fetchAllowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return labClient().readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] });
}

export async function fetchBalance(token: Address, owner: Address): Promise<bigint> {
  if (token === ZERO_ADDRESS) return labClient().getBalance({ address: owner });
  return labClient().readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
}
