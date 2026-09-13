import type { Metadata } from "next";
import { Lab } from "@/components/lab/lab";

export const metadata: Metadata = {
  title: "The Lab · buy and sell smart contracts on Robinhood Chain · LAURA",
  description:
    "The Lab is LAURA's frontend for the Ownership Market on Robinhood Chain: list any contract you own (NFT collection, token, vault, tool) for sale in any token, ownership escrowed by the market, 1% fee, no admin. Storefront metadata lives on-chain so anyone can host this frontend.",
};

export default function LabPage() {
  return <Lab />;
}
