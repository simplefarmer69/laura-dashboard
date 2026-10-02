import { createPublicClient, createWalletClient, formatEther, http, parseEventLogs } from "viem";
import { getAccount } from "@/lib/launchpad/service";
import { ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { DIRECT_LAUNCH_CAPS } from "@/lib/direct-launch/caps";
import type { DirectLaunch } from "@/lib/types";

/**
 * Pons (ponsfamily.com) V2 launch factory on Robinhood Chain. Source read
 * from the public contracts repo and the live factory probed on
 * 2026-10-02: the V1 factory is closed to new launchers; V2 is open
 * (canLaunch true for LAURA's wallet), one launch config (1B supply, 1%
 * curve fee, graduation at 4.2 ETH of quote), launch fee 0.0005 ETH paid
 * exactly, creator tax up to 1000 bps paid to creatorFeeRecipient on every
 * curve trade, deployer exempt from the snipe tax so an opening buy is
 * clean. Native ETH quote is pairToken address(0).
 */
export const PONS = {
  factoryV2: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as `0x${string}`,
  launchConfigId: 0n,
  nativeQuote: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  site: "https://www.ponsfamily.com",
  /** Opening buy tolerance against the simulated output */
  devBuySlippageBps: 300,
} as const;

export function ponsTokenUrl(token: string): string {
  return `${PONS.site}/launchpad/${token}`;
}

const FACTORY_ABI = [
  { type: "function", name: "canLaunch", stateMutability: "view", inputs: [{ name: "launcher", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "launchFee", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "maxCreatorTaxBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "launchConfigCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "previewLaunchEconomics",
    stateMutability: "view",
    inputs: [
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          {
            name: "socials",
            type: "tuple",
            components: [
              { name: "twitter", type: "string" },
              { name: "telegram", type: "string" },
              { name: "discord", type: "string" },
              { name: "website", type: "string" },
              { name: "farcaster", type: "string" },
            ],
          },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "curve", type: "address" },
    ],
  },
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "curve", type: "address", indexed: true },
      { name: "deployer", type: "address", indexed: true },
      { name: "pairToken", type: "address", indexed: false },
      { name: "launchConfigId", type: "uint256", indexed: false },
      { name: "graduationThreshold", type: "uint256", indexed: false },
    ],
  },
] as const;

const CURVE_ABI = [
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "quoteIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
] as const;

function publicClient() {
  return createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(undefined, { retryCount: 3, retryDelay: 800 }) });
}

export interface PonsStatus {
  open: boolean;
  reason: string;
  launchFeeEth: number;
  maxCreatorTaxBps: number;
}

/** Live read of whether LAURA's wallet may launch on Pons V2 right now, and at what fee. */
export async function ponsStatus(): Promise<PonsStatus> {
  const account = getAccount();
  if (!account) return { open: false, reason: "no wallet configured", launchFeeEth: 0, maxCreatorTaxBps: 0 };
  const client = publicClient();
  const [can, fee, maxTax, count] = await Promise.all([
    client.readContract({ address: PONS.factoryV2, abi: FACTORY_ABI, functionName: "canLaunch", args: [account.address] }),
    client.readContract({ address: PONS.factoryV2, abi: FACTORY_ABI, functionName: "launchFee" }),
    client.readContract({ address: PONS.factoryV2, abi: FACTORY_ABI, functionName: "maxCreatorTaxBps" }),
    client.readContract({ address: PONS.factoryV2, abi: FACTORY_ABI, functionName: "launchConfigCount" }),
  ]);
  const launchFeeEth = Number(formatEther(fee));
  if (!can) return { open: false, reason: "Pons V2 factory refuses this wallet (launches disabled and wallet not whitelisted)", launchFeeEth, maxCreatorTaxBps: Number(maxTax) };
  if (count <= PONS.launchConfigId) return { open: false, reason: "Pons V2 launch config 0 is gone", launchFeeEth, maxCreatorTaxBps: Number(maxTax) };
  if (launchFeeEth > DIRECT_LAUNCH_CAPS.maxEthPerLaunch) return { open: false, reason: `Pons launch fee ${launchFeeEth} ETH is over the ${DIRECT_LAUNCH_CAPS.maxEthPerLaunch} ETH per launch ceiling`, launchFeeEth, maxCreatorTaxBps: Number(maxTax) };
  return { open: true, reason: "", launchFeeEth, maxCreatorTaxBps: Number(maxTax) };
}

export interface PonsLaunchResult {
  token: `0x${string}`;
  curve: `0x${string}`;
  txHash: `0x${string}`;
  devBuyTxHash: `0x${string}` | null;
  costEth: number;
}

function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Launches the token on Pons V2 with LAURA's wallet as creator fee recipient,
 * then (optionally) makes the opening buy from the curve. Simulate first on
 * both sends; every ETH figure is checked against the caps before sending.
 */
export async function launchOnPons(launch: DirectLaunch, logoUrl: string, website: string): Promise<PonsLaunchResult> {
  const account = getAccount();
  if (!account) throw new Error("no wallet configured");
  const status = await ponsStatus();
  if (!status.open) throw new Error(status.reason);
  const client = publicClient();
  const wallet = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });

  const creatorTaxBps = Math.max(0, Math.min(launch.creatorTaxBps, status.maxCreatorTaxBps));
  const devBuyEth = Math.max(0, Math.min(launch.devBuyEth, DIRECT_LAUNCH_CAPS.maxDevBuyEth));
  const plannedEth = status.launchFeeEth + devBuyEth;
  if (plannedEth > DIRECT_LAUNCH_CAPS.maxEthPerLaunch) throw new Error(`fee ${status.launchFeeEth} + opening buy ${devBuyEth} ETH exceeds the ${DIRECT_LAUNCH_CAPS.maxEthPerLaunch} ETH ceiling`);

  const [balanceWei, fee, economics] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({ address: PONS.factoryV2, abi: FACTORY_ABI, functionName: "launchFee" }),
    client.readContract({ address: PONS.factoryV2, abi: FACTORY_ABI, functionName: "previewLaunchEconomics", args: [PONS.launchConfigId, PONS.nativeQuote] }),
  ]);
  const balanceEth = Number(formatEther(balanceWei));
  if (balanceEth - plannedEth - 0.002 < DIRECT_LAUNCH_CAPS.treasuryFloorEth) {
    throw new Error(`wallet ${balanceEth.toFixed(4)} ETH would drop under the ${DIRECT_LAUNCH_CAPS.treasuryFloorEth} ETH floor`);
  }

  const params = {
    name: launch.name,
    symbol: launch.symbol,
    logo: logoUrl,
    description: launch.message.slice(0, 400),
    socials: { twitter: "https://x.com/LAURA_DAIO", telegram: "", discord: "", website, farcaster: "" },
    creatorFeeRecipient: account.address,
    creatorTaxBps,
    buybackEnabled: launch.buybackEnabled,
    expectedEconomics: economics,
    salt: randomSalt(),
  } as const;

  const { request } = await client.simulateContract({
    account,
    address: PONS.factoryV2,
    abi: FACTORY_ABI,
    functionName: "launchToken",
    args: [params, PONS.launchConfigId, PONS.nativeQuote],
    value: fee,
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`Pons launchToken reverted: ${txHash}`);
  const launched = parseEventLogs({ abi: FACTORY_ABI, logs: receipt.logs, eventName: "TokenLaunched" }).find(
    (e) => e.address.toLowerCase() === PONS.factoryV2.toLowerCase(),
  );
  if (!launched) throw new Error(`Pons launch sent but no TokenLaunched event in ${txHash}`);
  const gasPrice = receipt.effectiveGasPrice ?? (await client.getGasPrice());
  let costEth = Number(formatEther(fee + receipt.gasUsed * gasPrice));

  let devBuyTxHash: `0x${string}` | null = null;
  if (devBuyEth > 0) {
    try {
      const quoteIn = BigInt(Math.round(devBuyEth * 1e18));
      const sim = await client.simulateContract({
        account,
        address: launched.args.curve,
        abi: CURVE_ABI,
        functionName: "buy",
        args: [quoteIn, 0n, account.address],
        value: quoteIn,
      });
      const minOut = (sim.result * BigInt(10_000 - PONS.devBuySlippageBps)) / 10_000n;
      const { request: buyReq } = await client.simulateContract({
        account,
        address: launched.args.curve,
        abi: CURVE_ABI,
        functionName: "buy",
        args: [quoteIn, minOut, account.address],
        value: quoteIn,
      });
      devBuyTxHash = await wallet.writeContract(buyReq);
      const buyReceipt = await client.waitForTransactionReceipt({ hash: devBuyTxHash, timeout: 180_000 });
      if (buyReceipt.status === "success") {
        costEth += Number(formatEther(quoteIn + buyReceipt.gasUsed * (buyReceipt.effectiveGasPrice ?? gasPrice)));
      } else {
        devBuyTxHash = null;
      }
    } catch {
      /* the launch stands without its opening buy */
      devBuyTxHash = null;
    }
  }

  return { token: launched.args.token, curve: launched.args.curve, txHash, devBuyTxHash, costEth };
}
