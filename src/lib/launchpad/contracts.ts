/**
 * Stonk Launcher / Smart Launch V2 integration surface.
 * Addresses and ABI from stonkbrokers.cash/docs ("Trading App Integration");
 * ABI vendored at ./StonkSafeLaunchpadV2.abi.json (official download).
 *
 * Lane naming, verified against the live stonkbrokers.cash client bundle
 * (2026-09-10): the site keys these pads "weth2" / "stonk2". They are the
 * Stonklauncher UI's ACTIVE lanes — the /launcher page's lane menu defaults
 * to the weth2 pad (`XJ.find(e => e.key === "weth2")` in the bundle), and
 * organic launches land there. Newer-generation "22" pads exist
 * (weth22 0x5BCEefBa6fDf437A7388aDC5c9056c827baca3B3) but the UI menu hides
 * them, and the bundle's legacy native pad
 * (0xEcA5726dae1e53365c37fFc02369d947A91d71f9) has creation disabled
 * (launchFeeWei = 1e24 wei sentinel). Do not "upgrade" lanes without
 * re-verifying which pad the UI's lane menu actually selects.
 */
export const LAUNCHPAD = {
  /**
   * StonkSafeLaunchpadV2 pad singletons, keyed by quote lane. Site keys are
   * the "2" generation (weth2 / stonk2 / gme2 / nvda2 ...). All addresses
   * from the launcher's deployments.safelaunch-v2.mainnet.json and verified
   * OPEN on-chain 2026-09-10 (launchFeeWei() == 0 on every pad, organic
   * launch counts on each). Stock-quoted lanes (gme/nvda/aapl/spcx/uso)
   * price their curve through Chainlink equity feeds that publish NOTHING
   * from Friday close to Monday 00:00 UTC (us_equities_24/5 schedule), so
   * lane availability is gated in ./lanes.ts - never deploy a stock lane
   * on a weekend.
   */
  pads: {
    weth: "0xFCd61B25BbF3AbD6cf0070D6328E351cc30EEC9f",
    stonk: "0x8f6782c5Aa37804d08a9b7bf3984Ff3245Fd6cD4",
    usdg: "0xd4F20033586977A2511f4A2DB4aF7C79a340D70a",
    gme: "0x4B9Dcd6CCFAeF0f6D23065Dd78E79d5E20ec8cFD",
    nvda: "0xEe96d955d5634813374ecE4C74F2C0ff71B1F9fB",
    aapl: "0xB0453A81Cbf963903409FFF18AD92941e1c7a864",
    spcx: "0x0c3b4EDED41696eFF0ed70841f132B519d81c947",
    uso: "0xDb3C81C841ff88db6cDFbDDB0eE049D162A6053B",
    /**
     * ARBITRUM ONE (chain 42161) WETH lane — operator directive 2026-09-15.
     * Address from the official StonkBrokers Launchpad guide rev 8 (Part 1,
     * table 1.1) and the live stonkbrokers.io /launcher bundle (lane key
     * "arbweth", floor id offset 31e6). Verified 2026-09-15: launchFeeWei()==0
     * (OPEN), launchCount 10 organic launches, isWethLane()==true, quote() ==
     * Arbitrum WETH, and every one of the 78 functions in our vendored V2 ABI
     * is present in the pad's bytecode. Same ABI, same createLaunch/arm flow,
     * different chain: see LANE_CHAIN / laneChain() below.
     */
    arbweth: "0x9540AC4173E5A8c7970743bd13aEc5E9e97FcD22",
  },
  /** SafeLaunchLensV2 — quotes and views; never reimplement curve tax math */
  lens: "0x25b5Df581f4b2Ed450203f375ad8A28b17F115B3",
  /** StonkLaunchpadFactory (factory-curve tokens) */
  factory: "0x80a77001456bc986083678F9a112B1EC2Aa07281",
  chainId: 4663,
  explorer: "https://robinhoodchain.blockscout.com",
  gridApi: "https://www.stonkbrokers.cash/api/launcher/tokens",
  /**
   * THE surface the /launcher (Stonklauncher) UI renders its boards from —
   * the client bundle fetches this and filters client-side. A launch is only
   * user-visible once its row here reports phase "live" (created-but-unarmed
   * launches sit as "waiting" and are effectively invisible). Verify against
   * this endpoint, not just tx receipts.
   */
  floorApi: "https://www.stonkbrokers.cash/api/safe-launch/floor",
} as const;

/**
 * Stonklauncher V3 on Arbitrum One (opened at fee 0 on 2026-09-15). Listed
 * for AWARENESS: the launcher feed, the Telegram bot and the intel radar read
 * these lanes, and the floor API mixes their rows in with Robinhood rows
 * (each Arbitrum row's `lane.chainId` is 42161; launch ids sit in their own
 * offset bands). LAURA's own deploy rail (executor.ts) still targets the
 * Robinhood pads above only: the swarm treasury, gas float and creator fee
 * plumbing all live on 4663, so an Arbitrum deploy target needs a funded
 * Arbitrum treasury and its own executor pass before it can be offered.
 */
export const LAUNCHPAD_ARBITRUM = {
  chainId: 42161,
  explorer: "https://arbiscan.io",
  lens: "0x7376f9dC6432434D611488CB3E852071ed29E276",
  /** Bond venue on Arbitrum is Uniswap v3 only. */
  bondVenue: "uniswap-v3",
  pads: {
    weth: "0x9540AC4173E5A8c7970743bd13aEc5E9e97FcD22",
    usdc: "0x42a561Bf35E311A59492ECe678315949a112D9ef",
    usdt: "0xAdc21631C65799fd5752EBEb0D55a4f28b73F098",
    wbtc: "0x2b2Df013f0fb71A46434d952B5A71C593fBF3d60",
    arb: "0xA6096F7c3186f815D1F477f9e9dE9f4323eF7241",
    gmx: "0xd3A44fB4fA4dd98662f511D5aF5B9399bF0E70CF",
    pendle: "0x36AAE654aD50b6e2D8c867703faB0160bA8b0B25",
    ape: "0x8D2a8236FC7294f736C537d22393259e3Db5C8F9",
    boop: "0xA08B9b63c0db362FB5e4b0ccc7f178cb10fc4AfF",
    pear: "0xF14971037dED25792Cd4D5516a9688F07D5bbabd",
    // Reality Protocol tokenized stocks (rSTOCK). Only rAAPL / rSPCX / rHOOD
    // have real Uniswap v3 depth; the rest are open pads with no pool yet.
    raapl: "0x009c43dD3C002B02965e0327ef35da0515c7c746",
    rspcx: "0xbc9Bc56D0018b9c1c71aaB74e917c89CC97A637E",
    rhood: "0xE467ADbE0671e1747242089169968Ad32e8BE09d",
    rnvda: "0xea69D73A62Bd25644b2d164BA1A56F521aeA8616",
    rtsla: "0x58329852104FFeA8103E8377E0DcBF5098667682",
    rmsft: "0x1338a39f86824A5a3a6282EEd3Ac399681600D63",
    rgoogl: "0x4Ad64B9b5990b37616bd297Ab1Cc11C3fbB2FAed",
    ramzn: "0xDBFf2b590B9b04b2A75D6d5249B666C3c373bdAb",
    rmeta: "0x238d85f92a1B2346C0262254B9E3d233C1ad32BE",
    rcoin: "0x6fce80BCe616aBd45a29fb286E5c86EfE989140D",
    rspy: "0xEECf01bac1BA354451AA2852727ebC304B2e5bA2",
  },
} as const;

export type ArbitrumPadLane = keyof typeof LAUNCHPAD_ARBITRUM.pads;

export type PadLane = keyof typeof LAUNCHPAD.pads;

/**
 * Literal tuple of the pad lane keys, for zod enums and iteration.
 * Must stay in step with LAUNCHPAD.pads; the `satisfies` clause plus the
 * Record<PadLane, ...> tables in ./lanes.ts make a drift a compile error.
 */
export const PAD_LANE_KEYS = [
  "weth",
  "stonk",
  "usdg",
  "gme",
  "nvda",
  "aapl",
  "spcx",
  "uso",
  "arbweth",
] as const satisfies readonly PadLane[];

/** Minimal ABI cut from the official StonkSafeLaunchpadV2.abi.json */
export const PAD_ABI = [
  {
    type: "function",
    name: "createLaunch",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "supply", type: "uint256" },
          { name: "vanitySalt", type: "bytes32" },
          { name: "startMcapUsd8", type: "uint64" },
          { name: "gradMcapUsd8", type: "uint64" },
          { name: "startTaxBps", type: "uint16" },
          { name: "taxDecayPerMinuteBps", type: "uint16" },
          { name: "sellsEnabled", type: "bool" },
          { name: "bufferSecs", type: "uint32" },
          { name: "unsoldMode", type: "uint8" },
          { name: "eoaOnly", type: "bool" },
          { name: "openEnded", type: "bool" },
          { name: "postTaxBps", type: "uint16" },
          { name: "bondVenue", type: "uint8" },
          { name: "maxBuyPpm", type: "uint32" },
        ],
      },
    ],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "token", type: "address" },
    ],
  },
  {
    type: "function",
    name: "arm",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "supplyWei", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "launchFeeWei",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "launchCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "bounds",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "minStartMcapUsd8", type: "uint64" },
      { name: "maxStartMcapUsd8", type: "uint64" },
      { name: "minGradMcapUsd8", type: "uint64" },
      { name: "maxGradMcapUsd8", type: "uint64" },
      { name: "maxStartTaxBps", type: "uint16" },
      { name: "minBufferSecs", type: "uint32" },
      { name: "maxOpenSecs", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "MIN_POST_TAX_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "MAX_POST_TAX_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "event",
    name: "LaunchCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "externalToken", type: "bool", indexed: false },
    ],
  },
  /* Custom errors the V2 pads throw from createLaunch/armLaunch, so viem
     decodes them by name instead of printing a bare selector. Selectors
     confirmed via openchain: BadEconomics() = 0x89f17dee. */
  { type: "error", name: "BadEconomics", inputs: [] },
  { type: "error", name: "BadParam", inputs: [] },
] as const;

/**
 * Turns a viem contract error into the one line a human needs. Known pad
 * errors get the rule they encode; anything else keeps its first meaningful
 * line (the full stack stays in the process log).
 */
export function explainPadError(err: unknown): string {
  const text = String(err);
  if (/BadEconomics|0x89f17dee/.test(text))
    return "Pad rejected the curve economics (BadEconomics): the start tax must be an exact multiple of the per-minute decay and the decay window must be 10-99 minutes. The executor snaps the spec onto the rule before the next attempt.";
  if (/BadParam/.test(text))
    return "Pad rejected a launch parameter (BadParam): closed-window sales (openEnded=false) and unsoldMode above 1 revert on every V2 pad.";
  if (/insufficient funds/i.test(text)) return "Wallet has insufficient ETH for the deploy fee plus gas.";
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^(Docs|Version|Details):/.test(l));
  return (firstLine ?? text).slice(0, 300);
}

/** Minimal ERC-20 surface used to load launch supply into the pad. */
export const ERC20_MIN_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ROBINHOOD_CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"],
    },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
} as const;

/**
 * Arbitrum One — the second chain the StonkBrokers launcher runs on
 * (operator directive 2026-09-15). Robinhood Chain itself settles to
 * Arbitrum One, so this is the launcher's parent chain. Same wallet address,
 * gas in ETH (~0.02 gwei, a createLaunch costs well under $0.01).
 */
export const ARBITRUM_ONE = {
  id: 42161,
  name: "Arbitrum One",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc"],
    },
  },
  blockExplorers: {
    default: { name: "Arbiscan", url: "https://arbiscan.io" },
  },
} as const;

export type LaunchChainKey = "robinhood" | "arbitrum";

export interface LaunchChainInfo {
  key: LaunchChainKey;
  chain: typeof ROBINHOOD_CHAIN | typeof ARBITRUM_ONE;
  label: string;
  /** SafeLaunchLensV2 on this chain (quotes + views; same ABI on both chains). */
  lens: `0x${string}`;
  /** Canonical WETH on this chain (the WETH lane's quote token). */
  weth: `0x${string}`;
  explorer: string;
  explorerName: string;
  /** Public launcher grid for this chain (rows carry safeHref/safePhase). */
  gridApi: string;
  /**
   * The floor rows the /launcher page renders. Null on Arbitrum until the
   * site cutover adds Arbitrum lanes there (guide rev 8 §1.2) — visibility on
   * Arbitrum is proven from the grid's safePhase plus the pad's armed flag.
   */
  floorApi: string | null;
  /** Post-bond venue for locked pools on this chain. */
  bondVenue: string;
}

export const LAUNCH_CHAINS: Record<LaunchChainKey, LaunchChainInfo> = {
  robinhood: {
    key: "robinhood",
    chain: ROBINHOOD_CHAIN,
    label: "Robinhood Chain",
    lens: "0x25b5Df581f4b2Ed450203f375ad8A28b17F115B3",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    explorer: "https://robinhoodchain.blockscout.com",
    explorerName: "Blockscout",
    gridApi: "https://www.stonkbrokers.cash/api/launcher/tokens",
    floorApi: "https://www.stonkbrokers.cash/api/safe-launch/floor",
    bondVenue: "StonkUp CL locker (Slipstream) or Uniswap v3",
  },
  arbitrum: {
    key: "arbitrum",
    chain: ARBITRUM_ONE,
    label: "Arbitrum One",
    /* Guide rev 8 Part 1: "Lens (all reads): 0x7376f9dC…E276"; 6.5 KB of code verified 2026-09-15. */
    lens: "0x7376f9dC6432434D611488CB3E852071ed29E276",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    explorer: "https://arbiscan.io",
    explorerName: "Arbiscan",
    gridApi: "https://stonkbrokers.io/api/launcher/tokens?chain=arbitrum",
    floorApi: null,
    bondVenue: "Uniswap v3 (1% fee tier) locked pool",
  },
};

/** Which chain each pad lane lives on. Every lane not listed here is Robinhood Chain. */
export const LANE_CHAIN: Record<PadLane, LaunchChainKey> = {
  weth: "robinhood",
  stonk: "robinhood",
  usdg: "robinhood",
  gme: "robinhood",
  nvda: "robinhood",
  aapl: "robinhood",
  spcx: "robinhood",
  uso: "robinhood",
  arbweth: "arbitrum",
};

/**
 * The launcher site's own lane key for a pad (the prefix of its
 * /safe-launch/token/<laneKey>-<symbol>-<launchId> route and the floor row's
 * lane.key). Robinhood V2 pads are the site's "2" generation.
 */
export const SITE_LANE_KEY: Record<PadLane, string> = {
  weth: "weth2",
  stonk: "stonk2",
  usdg: "usdg2",
  gme: "gme2",
  nvda: "nvda2",
  aapl: "aapl2",
  spcx: "spcx2",
  uso: "uso2",
  arbweth: "arbweth",
};

export function laneChainKey(lane: PadLane): LaunchChainKey {
  return LANE_CHAIN[lane] ?? "robinhood";
}

export function laneChain(lane: PadLane): LaunchChainInfo {
  return LAUNCH_CHAINS[laneChainKey(lane)];
}

/** Explorer token page for a launch on the lane's chain. */
export function explorerTokenUrl(lane: PadLane, token: string): string {
  return `${laneChain(lane).explorer}/token/${token}`;
}

/** Explorer tx page for a hash on the lane's chain. */
export function explorerTxUrl(lane: PadLane, txHash: string): string {
  return `${laneChain(lane).explorer}/tx/${txHash}`;
}

/**
 * The launcher UI trade page for a launch, built from the site's own route
 * pattern (verified 2026-09-15 against grid safeHref values on both chains:
 * "/safe-launch/token/weth2-laura-276", "/safe-launch/token/arbweth-stondog-1").
 */
export function launcherTokenUrl(lane: PadLane, symbol: string, launchId: string | number): string {
  const slug = symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "token";
  return `https://stonkbrokers.io/safe-launch/token/${SITE_LANE_KEY[lane]}-${slug}-${launchId}`;
}

/**
 * Every Arbitrum One pad from the live launcher bundle (21 lanes, 2026-09-15;
 * the guide rev 8 lists the first 12). All 21 read launchFeeWei()==0 (OPEN)
 * on 2026-09-15; only WETH (10), rSPCX (1) and rHOOD (1) had launches.
 * Reference data for the library and the agents manifest — only `arbweth` is
 * wired as a deploy lane today. The r-prefixed quotes are Reality Protocol
 * tokenized stocks (the site's UX applies a US courtesy gate, usGated);
 * ARB/WBTC/USDT/USDC/GMX/PENDLE/PEAR/APE/BOOP are open crypto quotes.
 * Quote decimals: USDC/USDT 6, WBTC 8, everything else 18.
 */
export const ARBITRUM_PADS: ReadonlyArray<{ lane: string; quoteSymbol: string; pad: `0x${string}`; quote: `0x${string}`; decimals: number; usGated: boolean }> = [
  { lane: "arbweth", quoteSymbol: "ETH", pad: "0x9540AC4173E5A8c7970743bd13aEc5E9e97FcD22", quote: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, usGated: false },
  { lane: "arbusdc", quoteSymbol: "USDC", pad: "0x42a561Bf35E311A59492ECe678315949a112D9ef", quote: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, usGated: false },
  { lane: "arbarb", quoteSymbol: "ARB", pad: "0xA6096F7c3186f815D1F477f9e9dE9f4323eF7241", quote: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, usGated: false },
  { lane: "arbwbtc", quoteSymbol: "WBTC", pad: "0x2b2Df013f0fb71A46434d952B5A71C593fBF3d60", quote: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, usGated: false },
  { lane: "arbusdt", quoteSymbol: "USDT", pad: "0xAdc21631C65799fd5752EBEb0D55a4f28b73F098", quote: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, usGated: false },
  { lane: "arbgmx", quoteSymbol: "GMX", pad: "0xd3A44fB4fA4dd98662f511D5aF5B9399bF0E70CF", quote: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", decimals: 18, usGated: false },
  { lane: "arbpendle", quoteSymbol: "PENDLE", pad: "0x36AAE654aD50b6e2D8c867703faB0160bA8b0B25", quote: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", decimals: 18, usGated: false },
  { lane: "arbpear", quoteSymbol: "PEAR", pad: "0xF14971037dED25792Cd4D5516a9688F07D5bbabd", quote: "0x3212dc0F8c834e4DE893532d27CC9B6001684DB0", decimals: 18, usGated: false },
  { lane: "arbape", quoteSymbol: "APE", pad: "0x8D2a8236FC7294f736C537d22393259e3Db5C8F9", quote: "0x7f9FBf9bDd3F4105C478b996B648FE6e828a1e98", decimals: 18, usGated: false },
  { lane: "arbboop", quoteSymbol: "BOOP", pad: "0xA08B9b63c0db362FB5e4b0ccc7f178cb10fc4AfF", quote: "0x13A7DeDb7169a17bE92B0E3C7C2315B46f4772B3", decimals: 18, usGated: false },
  { lane: "arbrnvda", quoteSymbol: "rNVDA", pad: "0xea69D73A62Bd25644b2d164BA1A56F521aeA8616", quote: "0x0a85b6EBe3C150A1979a65656E304033D62b1E12", decimals: 18, usGated: true },
  { lane: "arbrtsla", quoteSymbol: "rTSLA", pad: "0x58329852104FFeA8103E8377E0DcBF5098667682", quote: "0xf912911C9c8D5131929c758e66e6dc54e65cF3ba", decimals: 18, usGated: true },
  { lane: "arbrmsft", quoteSymbol: "rMSFT", pad: "0x1338a39f86824A5a3a6282EEd3Ac399681600D63", quote: "0xdA7c9549E87D4F96585701970AcDCc90E8d35024", decimals: 18, usGated: true },
  { lane: "arbrgoogl", quoteSymbol: "rGOOGL", pad: "0x4Ad64B9b5990b37616bd297Ab1Cc11C3fbB2FAed", quote: "0xcA1942EdEB697A85AF98eF8C74C4910fe9587afB", decimals: 18, usGated: true },
  { lane: "arbramzn", quoteSymbol: "rAMZN", pad: "0xDBFf2b590B9b04b2A75D6d5249B666C3c373bdAb", quote: "0xfba9E358F9AD443236155E5C67f2aADe032Db7A1", decimals: 18, usGated: true },
  { lane: "arbrmeta", quoteSymbol: "rMETA", pad: "0x238d85f92a1B2346C0262254B9E3d233C1ad32BE", quote: "0xB65f3005aB2aEede3707F56223C7c45f68cca008", decimals: 18, usGated: true },
  { lane: "arbrcoin", quoteSymbol: "rCOIN", pad: "0x6fce80BCe616aBd45a29fb286E5c86EfE989140D", quote: "0x412Ab56d122343dE6ABeaCceC646699BacD85601", decimals: 18, usGated: true },
  { lane: "arbrspy", quoteSymbol: "rSPY", pad: "0xEECf01bac1BA354451AA2852727ebC304B2e5bA2", quote: "0x9a0fda21276F245b89d2B7f1120F42e4466b1cb5", decimals: 18, usGated: true },
  { lane: "arbraapl", quoteSymbol: "rAAPL", pad: "0x009c43dD3C002B02965e0327ef35da0515c7c746", quote: "0xaBa5e0C80e9f58E391214689fB342049C0d31892", decimals: 18, usGated: true },
  { lane: "arbrspcx", quoteSymbol: "rSPCX", pad: "0xbc9Bc56D0018b9c1c71aaB74e917c89CC97A637E", quote: "0x5181b7Dd097B42d7787ee78Efab86f43D4E12f44", decimals: 18, usGated: true },
  { lane: "arbrhood", quoteSymbol: "rHOOD", pad: "0xE467ADbE0671e1747242089169968Ad32e8BE09d", quote: "0x485cb1ED5662a911EbA7f8547EB9E253cF43b8aE", decimals: 18, usGated: true },
];
