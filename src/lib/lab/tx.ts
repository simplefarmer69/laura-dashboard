"use client";
import { toast } from "sonner";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hash, type WalletClient } from "viem";
import { labClient } from "@/lib/lab/reads";
import { explorerTx } from "@/lib/lab/contracts";

/** Human wording for the market's custom errors, so a revert reads as advice, not hex. */
const REVERT_HINTS: Record<string, string> = {
  NotEscrowed: "The market does not hold ownership of this contract yet. The seller must transfer ownership to the market (Ownable2Step: then anyone calls Accept escrow).",
  NotTargetOwner: "Your wallet is not the current owner() of that contract, so it cannot list it.",
  AlreadyListed: "That contract already has a live listing.",
  NotAContract: "That address has no code on Robinhood Chain (or the payment token does not).",
  ZeroPrice: "Price must be more than zero.",
  DescriptionTooLong: "The on-chain description is limited to 280 bytes.",
  NotSeller: "Only the seller of this listing can do that.",
  NotBuyer: "Only the buyer of this listing can do that.",
  WrongStatus: "The listing is not in the right state for that action any more. Refresh and try again.",
  ListingChanged: "The listing's price or token changed since you loaded it. Refresh before buying.",
  WrongValue: "Send exactly the listed price (native listings) or no ETH (token listings).",
  TransferFailed: "The token transfer failed. Check your balance and allowance.",
  DeliveryFailed: "The target did not hand ownership to the buyer. The buyer can refund after 24h; nothing was charged.",
  RefundTooEarly: "Refunds open 24 hours after the sale if nobody delivered.",
  NothingToClaim: "Nothing left to claim here.",
  NotStale: "The listing is not stale: the seller or the market still owns the contract.",
  Reentrancy: "Re-entrant call blocked.",
  MetadataTooLong: "Metadata is limited to 3000 bytes. Shorten the description or drop a link.",
  NoListing: "No listing with that id.",
};

export function explainError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name && REVERT_HINTS[name]) return REVERT_HINTS[name];
    if (name) return `Reverted: ${name}`;
    const short = err.shortMessage || err.message;
    if (/user rejected|denied/i.test(short)) return "You rejected the request in your wallet.";
    return short.slice(0, 240);
  }
  const msg = String((err as { message?: string })?.message ?? err);
  if (/user rejected|denied/i.test(msg)) return "You rejected the request in your wallet.";
  return msg.slice(0, 240);
}

export interface TxSpec {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /** Toast label while pending */
  label: string;
}

/**
 * Simulates, sends and waits for one contract write with toast progress.
 * Returns the receipt hash, or null when the wallet refused / the call reverted.
 */
export async function runTx(client: WalletClient, spec: TxSpec): Promise<Hash | null> {
  const account = client.account;
  if (!account) {
    toast.error("Connect a wallet first.");
    return null;
  }
  const id = toast.loading(`${spec.label}: confirm in your wallet`);
  try {
    const pub = labClient();
    const { request } = await pub.simulateContract({
      account,
      address: spec.address,
      abi: spec.abi,
      functionName: spec.functionName,
      args: spec.args as never,
      value: spec.value,
    });
    const hash = await client.writeContract(request as never);
    toast.loading(`${spec.label}: waiting for confirmation`, { id, description: hash });
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
    if (receipt.status !== "success") {
      toast.error(`${spec.label}: transaction reverted`, { id, description: hash });
      return null;
    }
    toast.success(`${spec.label}: done`, {
      id,
      description: hash,
      action: { label: "Explorer", onClick: () => window.open(explorerTx(hash), "_blank", "noreferrer") },
    });
    return hash;
  } catch (err) {
    toast.error(`${spec.label} failed`, { id, description: explainError(err) });
    return null;
  }
}
