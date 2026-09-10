/**
 * Stonk Launcher / Smart Launch V2 integration surface.
 * Addresses and ABI from stonkbrokers.cash/docs ("Trading App Integration");
 * ABI vendored at ./StonkSafeLaunchpadV2.abi.json (official download).
 */
export const LAUNCHPAD = {
  /** StonkSafeLaunchpadV2 pad singletons, keyed by quote lane */
  pads: {
    weth: "0xFCd61B25BbF3AbD6cf0070D6328E351cc30EEC9f",
    stonk: "0x8f6782c5Aa37804d08a9b7bf3984Ff3245Fd6cD4",
  },
  /** SafeLaunchLensV2 — quotes and views; never reimplement curve tax math */
  lens: "0x25b5Df581f4b2Ed450203f375ad8A28b17F115B3",
  /** StonkLaunchpadFactory (factory-curve tokens) */
  factory: "0x80a77001456bc986083678F9a112B1EC2Aa07281",
  chainId: 4663,
  explorer: "https://robinhoodchain.blockscout.com",
  gridApi: "https://www.stonkbrokers.cash/api/launcher/tokens",
} as const;

export type PadLane = keyof typeof LAUNCHPAD.pads;

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
] as const;

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
