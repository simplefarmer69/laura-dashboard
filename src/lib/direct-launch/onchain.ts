import { createPublicClient, createWalletClient, encodeDeployData, formatEther, http, parseEventLogs, type Abi } from "viem";
import { getAccount } from "@/lib/launchpad/service";
import { LAUNCHPAD, LAUNCH_CHAINS, ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { VDEX } from "@/lib/launchpad/smart-lp";
import { compileSource, type CompileSuccess } from "@/lib/forge/compile";
import { DIRECT_LAUNCH_CAPS } from "@/lib/direct-launch/caps";
import { TAX_TOKEN_ABI, TAX_TOKEN_CONTRACT_NAME, TAX_TOKEN_SOURCE, taxTokenConstructorValues } from "@/lib/direct-launch/contract";
import { singleSidedRange } from "@/lib/direct-launch/tick-math";
import type { DirectLaunch } from "@/lib/types";

/**
 * The direct rail: deploy LAURA's tax token, open its vDEX concentrated
 * liquidity pool at the designed start price, mark the pool on the token,
 * seed the WHOLE supply as a single sided (token only) position from the
 * start price up to the range top, and finalize the token so no admin key
 * survives. LAURA keeps the position NFT; there is no exit path in code,
 * so the liquidity stays where it was put. Every send is simulated first
 * and the wallet floor is checked before the first transaction.
 */

const WETH = LAUNCH_CHAINS.robinhood.weth;
const LENS = LAUNCH_CHAINS.robinhood.lens;
/** Slipstream pools reject a tick spacing the factory does not list; 200 is the vDEX's 0.3% tier. */
const TICK_SPACING = VDEX.tickSpacing;
/** Token side tolerance on the seed (the position is one sided; a tick of rounding is all that can go missing). */
const SEED_TOLERANCE_BPS = 100;
const TX_TIMEOUT_MS = 180_000;

const LENS_ABI = [
  {
    type: "function",
    name: "ethUsdView",
    stateMutability: "view",
    inputs: [{ name: "pad", type: "address" }],
    outputs: [
      { name: "usd8", type: "uint256" },
      { name: "fresh", type: "bool" },
    ],
  },
] as const;

const CL_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "tickSpacing", type: "int24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "tickSpacing", type: "int24" },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

const NPM_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "sqrtPriceX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

const POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

function publicClient() {
  return createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(undefined, { retryCount: 3, retryDelay: 800 }) });
}

let compiled: Promise<CompileSuccess> | null = null;

/** The template compiles once per process; the bytes are identical for every launch. */
export function compiledTaxToken(): Promise<CompileSuccess> {
  if (!compiled) {
    compiled = compileSource(TAX_TOKEN_SOURCE, TAX_TOKEN_CONTRACT_NAME).then((r) => {
      if (!r.ok) throw new Error(`tax token template failed to compile: ${r.errors.join("; ").slice(0, 300)}`);
      return r;
    });
    compiled.catch(() => {
      compiled = null;
    });
  }
  return compiled;
}

/** ETH price in USD from the launchpad lens oracle (the same read the pads price with). */
export async function ethUsdNow(): Promise<number> {
  const [usd8] = await publicClient().readContract({ address: LENS, abi: LENS_ABI, functionName: "ethUsdView", args: [LAUNCHPAD.pads.weth as `0x${string}`] });
  const usd = Number(usd8) / 1e8;
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("ETH/USD oracle read unusable");
  return usd;
}

export interface DirectDeployResult {
  token: `0x${string}`;
  pool: `0x${string}`;
  lpTokenId: string;
  txHash: `0x${string}`;
  costEth: number;
  /** For the record: where the pool opened and where the range runs */
  tickLower: number;
  tickUpper: number;
  startPriceWethPerToken: number;
}

export interface DirectDeployPlan {
  supplyWei: bigint;
  ethUsd: number;
  startPriceWethPerToken: number;
  topPriceWethPerToken: number;
}

/** Prices the design against the live ETH/USD read. Pure apart from the oracle call. */
export async function planDirectDeploy(launch: DirectLaunch): Promise<DirectDeployPlan> {
  const ethUsd = await ethUsdNow();
  const supplyWei = BigInt(Math.round(launch.supplyTokens)) * 10n ** 18n;
  const startPriceWethPerToken = launch.startMcapUsd / ethUsd / launch.supplyTokens;
  const topPriceWethPerToken = launch.rangeTopMcapUsd / ethUsd / launch.supplyTokens;
  return { supplyWei, ethUsd, startPriceWethPerToken, topPriceWethPerToken };
}

export interface DirectDeployProgress {
  token?: `0x${string}`;
  txHash?: `0x${string}`;
  pool?: `0x${string}`;
  lpTokenId?: string;
}

/**
 * `progress` fires as soon as each address is known so the record can keep
 * it even if a later step fails: a token that exists must never be deployed
 * twice because the pool step reverted.
 */
export async function deployDirectLaunch(
  launch: DirectLaunch,
  log: (msg: string) => void,
  progress: (p: DirectDeployProgress) => Promise<void> = async () => undefined,
): Promise<DirectDeployResult> {
  const account = getAccount();
  if (!account) throw new Error("no wallet configured");
  const client = publicClient();
  const wallet = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
  const [build, plan, balanceWei, gasPrice] = await Promise.all([compiledTaxToken(), planDirectDeploy(launch), client.getBalance({ address: account.address }), client.getGasPrice()]);

  const abi = build.abi as Abi;
  const args = taxTokenConstructorValues({
    name: launch.name,
    symbol: launch.symbol,
    supplyWei: plan.supplyWei,
    treasury: account.address,
    startTaxBps: launch.startTaxBps,
    floorTaxBps: launch.floorTaxBps,
    decayBpsPerMinute: launch.decayBpsPerMinute,
    holderShareBps: launch.holderShareBps,
    burnShareBps: launch.burnShareBps,
    rewardMode: launch.rewardMode === "diamond" ? 1 : 0,
  });

  /* Budget the whole sequence (deploy plus four follow up sends) before the first byte goes out. */
  const deployData = encodeDeployData({ abi, bytecode: build.bytecode, args: args as never });
  const deployGas = await client.estimateGas({ account, data: deployData });
  const sequenceGas = (deployGas + 1_200_000n) * 125n / 100n;
  const costEstimateEth = Number(formatEther(sequenceGas * gasPrice));
  if (costEstimateEth > DIRECT_LAUNCH_CAPS.maxDeployCostEth) throw new Error(`launch sequence would cost ~${costEstimateEth.toFixed(5)} ETH in gas; ceiling ${DIRECT_LAUNCH_CAPS.maxDeployCostEth}`);
  const balanceEth = Number(formatEther(balanceWei));
  if (balanceEth - costEstimateEth < DIRECT_LAUNCH_CAPS.treasuryFloorEth) {
    throw new Error(`wallet ${balanceEth.toFixed(4)} ETH would drop under the ${DIRECT_LAUNCH_CAPS.treasuryFloorEth} ETH floor`);
  }

  let spentWei = 0n;
  const settle = async (hash: `0x${string}`, what: string) => {
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS });
    spentWei += receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice);
    if (receipt.status !== "success") throw new Error(`${what} reverted: ${hash}`);
    return receipt;
  };

  /* 1. Token */
  const txHash = await wallet.deployContract({ abi, bytecode: build.bytecode, args: args as never, gas: (deployGas * 125n) / 100n });
  const deployReceipt = await settle(txHash, "token deploy");
  const token = deployReceipt.contractAddress;
  if (!token) throw new Error(`deploy produced no contract address: ${txHash}`);
  log(`direct: ${launch.symbol} token at ${token}`);
  await progress({ token, txHash });

  /* 2. Pool at the designed start price, one tick outside the token side of the range */
  const range = singleSidedRange(token, WETH, plan.startPriceWethPerToken, plan.topPriceWethPerToken, TICK_SPACING);
  const existing = await client.readContract({ address: VDEX.clFactory, abi: CL_FACTORY_ABI, functionName: "getPool", args: [range.token0, range.token1, TICK_SPACING] });
  let pool: `0x${string}`;
  if (existing !== "0x0000000000000000000000000000000000000000") {
    pool = existing;
    log(`direct: pool for ${launch.symbol} already existed at ${pool}; using it`);
  } else {
    const { request, result } = await client.simulateContract({
      account,
      address: VDEX.clFactory,
      abi: CL_FACTORY_ABI,
      functionName: "createPool",
      args: [range.token0, range.token1, TICK_SPACING, range.sqrtPriceX96],
    });
    pool = result;
    await settle(await wallet.writeContract(request), "createPool");
    log(`direct: pool ${pool} opened at tick ${range.initTick} (range ${range.tickLower}..${range.tickUpper})`);
  }
  await progress({ pool });

  /* 3. Mark the pool so buys are taxed from the first swap */
  {
    const { request } = await client.simulateContract({ account, address: token, abi: TAX_TOKEN_ABI, functionName: "markPool", args: [pool, VDEX.positionManager] });
    await settle(await wallet.writeContract(request), "markPool");
  }

  /* 4. Seed the whole supply, token side only */
  {
    const { request } = await client.simulateContract({ account, address: token, abi: TAX_TOKEN_ABI, functionName: "approve", args: [VDEX.positionManager, plan.supplyWei] });
    await settle(await wallet.writeContract(request), "approve");
  }
  const [slot0, head] = await Promise.all([client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }), client.getBlock()]);
  const currentTick = Number(slot0[1]);
  const tokenSideClear = range.tokenIsToken0 ? currentTick < range.tickLower : currentTick >= range.tickUpper;
  if (!tokenSideClear) throw new Error(`pool tick ${currentTick} is inside the range ${range.tickLower}..${range.tickUpper}; a one sided seed is not possible`);
  const minToken = (plan.supplyWei * BigInt(10_000 - SEED_TOLERANCE_BPS)) / 10_000n;
  const mintParams = {
    token0: range.token0,
    token1: range.token1,
    tickSpacing: TICK_SPACING,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    amount0Desired: range.tokenIsToken0 ? plan.supplyWei : 0n,
    amount1Desired: range.tokenIsToken0 ? 0n : plan.supplyWei,
    amount0Min: range.tokenIsToken0 ? minToken : 0n,
    amount1Min: range.tokenIsToken0 ? 0n : minToken,
    recipient: account.address,
    deadline: head.timestamp + 900n,
    sqrtPriceX96: 0n,
  } as const;
  const { request: mintReq } = await client.simulateContract({ account, address: VDEX.positionManager, abi: NPM_ABI, functionName: "mint", args: [mintParams] });
  const mintReceipt = await settle(await wallet.writeContract(mintReq), "LP mint");
  const minted = parseEventLogs({ abi: NPM_ABI, logs: mintReceipt.logs, eventName: "Transfer" }).find(
    (t) => t.address.toLowerCase() === VDEX.positionManager.toLowerCase() && t.args.to.toLowerCase() === account.address.toLowerCase(),
  );
  if (!minted) throw new Error(`LP mint succeeded but no position NFT found in ${mintReceipt.transactionHash}`);
  log(`direct: ${launch.symbol} seeded, position #${minted.args.tokenId}`);
  await progress({ lpTokenId: minted.args.tokenId.toString() });

  /* 5. Burn the admin key */
  {
    const { request } = await client.simulateContract({ account, address: token, abi: TAX_TOKEN_ABI, functionName: "finalize" });
    await settle(await wallet.writeContract(request), "finalize");
  }

  return {
    token,
    pool,
    lpTokenId: minted.args.tokenId.toString(),
    txHash,
    costEth: Number(formatEther(spentWei)),
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    startPriceWethPerToken: plan.startPriceWethPerToken,
  };
}

/** Live reads for the console and the verify pass: tax now, rewards paid, burned, treasury share. */
export async function readTaxTokenStats(token: `0x${string}`): Promise<{ currentTaxBps: number; rewardsDistributed: number; burned: number; treasuryTax: number; finalized: boolean }> {
  const client = publicClient();
  const [tax, rewards, burned, treasury, owner] = await Promise.all([
    client.readContract({ address: token, abi: TAX_TOKEN_ABI, functionName: "currentTaxBps" }),
    client.readContract({ address: token, abi: TAX_TOKEN_ABI, functionName: "totalRewardsDistributed" }),
    client.readContract({ address: token, abi: TAX_TOKEN_ABI, functionName: "totalBurned" }),
    client.readContract({ address: token, abi: TAX_TOKEN_ABI, functionName: "totalTreasuryTax" }),
    client.readContract({ address: token, abi: TAX_TOKEN_ABI, functionName: "owner" }),
  ]);
  return {
    currentTaxBps: Number(tax),
    rewardsDistributed: Number(formatEther(rewards)),
    burned: Number(formatEther(burned)),
    treasuryTax: Number(formatEther(treasury)),
    finalized: owner === "0x0000000000000000000000000000000000000000",
  };
}
