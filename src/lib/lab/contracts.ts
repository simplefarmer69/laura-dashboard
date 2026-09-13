import { parseAbi, type Address } from "viem";

/**
 * The Lab: LAURA's frontend for the Ownership Market and its metadata
 * registry on Robinhood Chain. Everything here is client-bundle safe and
 * pure data, so anyone can lift this file to host their own frontend.
 */

/**
 * Hosting your own copy: NEXT_PUBLIC_LAB_RPC_URL, NEXT_PUBLIC_LAB_MARKET and
 * NEXT_PUBLIC_LAB_REGISTRY override the RPC and the contract addresses at
 * build time (they are also what the local anvil harness uses).
 */
const RPC_URL = process.env.NEXT_PUBLIC_LAB_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export const LAB_CHAIN = {
  id: Number(process.env.NEXT_PUBLIC_LAB_CHAIN_ID || 4663),
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address } },
} as const;

export const EXPLORER_URL = LAB_CHAIN.blockExplorers.default.url;

/** OwnershipMarket, deployed and verified 2026-09-13 (flagship key "ownership-market"). */
export const MARKET_ADDRESS: Address = (process.env.NEXT_PUBLIC_LAB_MARKET as Address | undefined) || "0x184aceB1FFE04701d6fdF75f7AdC638651578923";
/** LabRegistry (flagship key "lab-registry"); null until the swarm deploys it, then discovered from /api/forge. */
export const REGISTRY_ADDRESS_FALLBACK: Address | null = (process.env.NEXT_PUBLIC_LAB_REGISTRY as Address | undefined) || null;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const MARKET_ABI = parseAbi([
  "function FEE_BPS() view returns (uint256)",
  "function MAX_DESCRIPTION_BYTES() view returns (uint256)",
  "function REFUND_DELAY() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function listingCount() view returns (uint256)",
  "function activeListingOf(address target) view returns (uint256)",
  "function accruedFees(address payToken) view returns (uint256)",
  "function getListing(uint256 id) view returns ((address target, address seller, address buyer, address payToken, uint256 price, uint256 paid, uint64 createdAt, uint64 soldAt, uint8 status, bool proceedsClaimed, string description))",
  "function isEscrowed(uint256 id) view returns (bool)",
  "function quote(uint256 paid) pure returns (uint256 fee, uint256 proceeds)",
  "function createListing(address target, address payToken, uint256 price, string description) returns (uint256 id)",
  "function updateListing(uint256 id, address payToken, uint256 price, string description)",
  "function acceptEscrow(uint256 id)",
  "function cancel(uint256 id)",
  "function expire(uint256 id)",
  "function buy(uint256 id, address expectedPayToken, uint256 expectedPrice) payable",
  "function deliver(uint256 id)",
  "function claimProceeds(uint256 id)",
  "function refund(uint256 id)",
  "function withdrawFees(address payToken)",
  "event Listed(uint256 indexed id, address indexed target, address indexed seller, address payToken, uint256 price, string description)",
  "event Sold(uint256 indexed id, address indexed buyer, address payToken, uint256 paid)",
  "event Delivered(uint256 indexed id, address indexed target, address indexed newOwner, uint256 fee)",
  "error Reentrancy()",
  "error ZeroAddress()",
  "error ZeroPrice()",
  "error DescriptionTooLong()",
  "error NotAContract()",
  "error AlreadyListed()",
  "error NotTargetOwner()",
  "error NotSeller()",
  "error NotBuyer()",
  "error WrongStatus()",
  "error NotEscrowed()",
  "error ListingChanged()",
  "error WrongValue()",
  "error TransferFailed()",
  "error DeliveryFailed()",
  "error RefundTooEarly()",
  "error NothingToClaim()",
  "error NotStale()",
]);

export const REGISTRY_ABI = parseAbi([
  "function market() view returns (address)",
  "function MAX_METADATA_BYTES() view returns (uint256)",
  "function getMetadata(uint256 id) view returns (string metadata, address setBy, uint64 updatedAt)",
  "function getMetadataBatch(uint256 fromId, uint256 toId) view returns ((string metadata, address setBy, uint64 updatedAt)[])",
  "function setMetadata(uint256 id, string metadata)",
  "function clearMetadata(uint256 id)",
  "error ZeroAddress()",
  "error NoListing()",
  "error NotSeller()",
  "error MetadataTooLong()",
]);

/** The two calls the market makes on a target, plus the Ownable2Step pair. */
export const OWNABLE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
]);

export const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export type ListingStatus = "none" | "listed" | "sold" | "delivered" | "cancelled" | "refunded";

export const STATUS_BY_CODE: ListingStatus[] = ["none", "listed", "sold", "delivered", "cancelled", "refunded"];

export interface Listing {
  id: number;
  target: Address;
  seller: Address;
  buyer: Address;
  payToken: Address;
  price: bigint;
  paid: bigint;
  createdAt: number;
  soldAt: number;
  status: ListingStatus;
  proceedsClaimed: boolean;
  description: string;
  /** Live: does the market hold owner() of the target right now? */
  escrowed: boolean;
}

/** Payment tokens the Sell form offers by name; any ERC-20 address also works. */
export const PAYMENT_PRESETS: ReadonlyArray<{ symbol: string; address: Address; decimals: number }> = [
  { symbol: "ETH", address: ZERO_ADDRESS, decimals: 18 },
  { symbol: "WETH", address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", decimals: 18 },
  { symbol: "USDG", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6 },
  { symbol: "STONKBROKER", address: "0xe934e36A439C94017B64a3FecE66AF12099aBF50", decimals: 18 },
];

export const FEE_BPS = 100;
export const REFUND_DELAY_S = 86_400;

export function explorerAddress(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function explorerContract(address: string): string {
  return `${EXPLORER_URL}/address/${address}?tab=contract`;
}

export function explorerTx(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}
