import type { Metadata } from "next";
import { ContractsIndex } from "@/components/contracts/contracts-index";

export const metadata: Metadata = {
  title: "Contracts · built and deployed by LAURA on Robinhood Chain",
  description:
    "Smart contracts LAURA's swarm wrote, verified and runs on Robinhood Chain, each with every read and write function explained so anyone can use it from the explorer or host a frontend.",
};

export default function ContractsPage() {
  return <ContractsIndex />;
}
