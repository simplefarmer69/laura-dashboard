import type { OnchainReads, Settings } from "@/lib/types";

/** Mainnet contract addresses from stonkbrokers.cash/docs. */
export const CONTRACTS = {
  nftCollection: "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0",
  ammVault: "0xe302733accf4800146e55fc45b46b4e4ffc032d2",
  clockInV2: "0x1f12fe622c11947f93f53d63f68f7f46b6d081c9",
} as const;

export const TOTAL_BROKERS = 4444;
const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SEL_TOTAL_SUPPLY = "0x18160ddd";
const SEL_BALANCE_OF = "0x70a08231";

interface RpcResponse {
  result?: string;
  error?: { message: string };
}

async function rpc(method: string, params: unknown[]): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as RpcResponse;
    if (json.error) throw new Error(json.error.message);
    if (!json.result) throw new Error("empty RPC result");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

function hexToNumber(hex: string, decimals = 0): number {
  const big = BigInt(hex);
  if (decimals === 0) return Number(big);
  const scale = BigInt(10) ** BigInt(decimals);
  return Number(big / scale) + Number(big % scale) / Number(scale);
}

function pad32(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export async function fetchOnchain(settings: Settings, ethPriceUsd: number): Promise<OnchainReads> {
  const [block, pot, supply, vaultBrokers] = await Promise.all([
    rpc("eth_blockNumber", []),
    rpc("eth_getBalance", [CONTRACTS.clockInV2, "latest"]),
    rpc("eth_call", [{ to: settings.tokenAddress, data: SEL_TOTAL_SUPPLY }, "latest"]),
    rpc("eth_call", [
      { to: CONTRACTS.nftCollection, data: `${SEL_BALANCE_OF}${pad32(CONTRACTS.ammVault)}` },
      "latest",
    ]),
  ]);
  const clockInPotEth = hexToNumber(pot, 18);
  const brokersInVault = hexToNumber(vaultBrokers);
  return {
    blockNumber: hexToNumber(block),
    ethPriceUsd,
    clockInPotEth,
    clockInPotUsd: clockInPotEth * ethPriceUsd,
    brokersInVault,
    brokersInCirculation: TOTAL_BROKERS - brokersInVault,
    tokenTotalSupply: hexToNumber(supply, 18),
  };
}
