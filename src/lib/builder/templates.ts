import ARTIFACTS from "@/lib/builder/artifacts.json";
import type { UtilityKind } from "@/lib/types";

/**
 * Allowlisted utility contract templates. The Solidity sources live beside
 * this file in ./contracts/ and were compiled ONCE locally (solc 0.8.28,
 * optimizer 200 runs) into ./artifacts.json, so the VM never needs a
 * compiler and the builder can never deploy bytecode that is not already
 * vendored and reviewed in this repo.
 *
 * Template ground rules (enforced by what is in the registry, not by trust):
 * no owner, no admin path, no proxy, no upgrade hook, no custody of user
 * funds beyond the faucet's own donated bag.
 */
interface Artifact {
  source: string;
  compiler: string;
  optimizer: { enabled: boolean; runs: number };
  abi: unknown[];
  bytecode: string;
}

const artifacts = ARTIFACTS as unknown as Record<string, Artifact>;

export interface UtilityTemplate {
  kind: UtilityKind;
  contractName: string;
  /** True when shipping means deploying a contract (vs a dashboard-only surface) */
  onchain: boolean;
  /** True when the template needs LAURA's acquired bag transferred in after deploy */
  needsFunding: boolean;
  describe: string;
}

export const UTILITY_TEMPLATES: Record<UtilityKind, UtilityTemplate> = {
  "faucet-drip": {
    kind: "faucet-drip",
    contractName: "FaucetDrip",
    onchain: true,
    needsFunding: true,
    describe:
      "Ownerless faucet holding LAURA's acquired bag; any wallet claims a fixed amount per fixed interval until the bag runs dry.",
  },
  "burn-pledge": {
    kind: "burn-pledge",
    contractName: "BurnPledge",
    onchain: true,
    needsFunding: false,
    describe:
      "Burn-to-signal registry: holders pledge tokens straight to the dead address with a message, building a conviction leaderboard. Never holds funds.",
  },
  "holder-leaderboard": {
    kind: "holder-leaderboard",
    contractName: "",
    onchain: false,
    needsFunding: false,
    describe: "Dashboard-rendered holder leaderboard for the token; ships as snapshot data, no chain action.",
  },
  "gated-lore": {
    kind: "gated-lore",
    contractName: "",
    onchain: false,
    needsFunding: false,
    describe: "Dashboard-rendered lore/quest page concept for holders; ships as snapshot data, no chain action.",
  },
};

export function templateArtifact(kind: UtilityKind): Artifact | null {
  const t = UTILITY_TEMPLATES[kind];
  if (!t.onchain) return null;
  const a = artifacts[t.contractName];
  if (!a || !a.bytecode || a.bytecode === "0x") throw new Error(`missing artifact for ${t.contractName}`);
  return a;
}
