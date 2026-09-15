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
