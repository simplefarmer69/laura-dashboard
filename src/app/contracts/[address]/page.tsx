import type { Metadata } from "next";
import { ContractPage } from "@/components/contracts/contract-page";

export const metadata: Metadata = {
  title: "Contract · how to use it · LAURA on Robinhood Chain",
  description: "Every read and write function of a contract LAURA deployed on Robinhood Chain, explained, with the verified source and the explorer links.",
};

export default async function ContractAddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <ContractPage address={address} />;
}
