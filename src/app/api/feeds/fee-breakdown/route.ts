import { createPublicClient, http, parseAbiItem } from "viem";
import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * Fee attribution feed - answers the swarm's "which surface generates the
 * fees" question from onchain events instead of the blended DefiLlama
 * series. The blend mixes many surfaces (the fees adapter counts launchpad
 * taxes, Smart LP collections, flat Anvil ETH fees, locked LP fee claims
 * AND the protocol owned Uniswap v4 STONK/ETH position's LP fee income,
 * while the dex volume adapter counts only Anvil AMM NFT swap volume), so
 * ratios like fees/volume swing without any surface actually changing. This
 * attributes fees PER SURFACE for ~24h and ~7d windows:
 *
 *   activations   ActivationEthFeePaid on Anvil soft staking vaults
 *   anvil_swaps   RobinhoodSwapFeePaid on Anvil AMM vaults (flat ~$2 ETH)
 *   loans         LoanEthFeePaid on Anvil loan vaults (flat ~$2 ETH)
 *   launchpad_tax SafeBuy/SafeSell taxPaid across every Stonklauncher pad
 *   smart_lp      FeesCollected on Smart LP vaults (plus the 10% skim)
 *   vesting       PositionLocked on the vesting locker (1 bps deposit fee)
 *
 * Scan shape: ONE chunked eth_getLogs walk with all six topic0 hashes OR'd,
 * over a contiguous module window [low, high] - forward catch up to head
 * plus a bounded backward seed toward the 7d floor each request. Bounds only
 * move after a chunk fully succeeds, so a failed chunk replays next pass and
 * the buckets never silently skip a range. Events aggregate into hourly
 * buckets (timestamps estimated from a two point block/time anchor - the
 * chain runs ~10 blocks/s), so memory stays flat at any window size.
 * Coverage is reported honestly: d1/d7 carry `complete: false` until the
 * backward seed has reached that window's start.
 *
 * Sources (public, unkeyed): Robinhood Chain RPC (ROBINHOOD_RPC_URL
 * overrides), stonkbrokers.io/api/safe-launch/{floor,stats} for pad quote
 * metadata + ethUsd fallback, the SmartLpLens for vault pair metadata,
 * coins.llama.fi for the ETH mark, api.llama.fi summaries for the blended
 * reconciliation figures.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SB = "https://stonkbrokers.io/api/safe-launch";
const LLAMA = "https://api.llama.fi";
const LLAMA_ETH = "https://coins.llama.fi/prices/current/coingecko:ethereum";

/** The V1 ETH pad - its rows carry no lane in the floor payload. */
const ETH_PAD = "0xeca5726dae1e53365c37ffc02369d947a91d71f9";
/** Smart LP registry + lens (same pair the smartlp feed reads). */
const REGISTRY = "0xE8749183Fbf6A657EB58B3a4D3E4B9Cc09560146" as const;
const LENS = "0x754Bf8479630bbC22aA7b5E9742156ce89dD3D4d" as const;
/** Vesting locker (Safety Deposit Box token vesting, 1 bps deposit fee). */
const VESTING_LOCKER = "0x2b4ad79da7bd3bf340bbd2ad2039b149214e9aa9";

const client = createPublicClient({ transport: http(RPC_URL, { timeout: 12_000 }) });

/* ------------------------------ fee events ------------------------------ */
/* topic0 hashes verified against live logs on Robinhood Chain:
 *   ActivationEthFeePaid 0xb8b07b94279a1e4c4863b2fa8c894153e8e2640e8bf00672f8fc98df8e3f984e
 *   RobinhoodSwapFeePaid 0x5b3759dffc4fa0cd2f11bb4bb0a11122abc82c62464f79a53ef203a714751404
 *   LoanEthFeePaid       0x2ad7050fb1cfded5fbaa71faf30e2f33b3c6c4656924791412b417f1bc4ca123
 *   SafeBuy              0xba22b06917da96d20a8f4f80d45cbdaaf3294856de78268558edcce22e4298df
 *   SafeSell             0x2de6d6d1573ee69658d3daae2e752379e6eb0676622a5ade2812088d7cb56581
 *   FeesCollected        0xf5d590414d56d256b8c16b850d0b57f2f5d2ed90686166e150b48a96f0dbdd61
 *   PositionLocked       0x77176a3032a52a944a7d0b11796c888e6914bd6628c6671bc8b5e56d34a54066
 */
const EVENTS = [
  parseAbiItem("event ActivationEthFeePaid(uint256 indexed tokenId, address indexed payer, uint256 amount)"),
  parseAbiItem("event RobinhoodSwapFeePaid(address indexed payer, uint256 feeWei, address treasury, address booster)"),
  parseAbiItem("event LoanEthFeePaid(uint256 indexed loanId, address indexed payer, uint256 amount)"),
  parseAbiItem(
    "event SafeBuy(uint256 indexed id, address indexed buyer, uint256 ethIn, uint256 taxPaid, uint256 taxBps, uint256 tokensOut, uint256 mcapUsd8)",
  ),
  parseAbiItem(
    "event SafeSell(uint256 indexed id, address indexed seller, uint256 tokensIn, uint256 taxPaid, uint256 taxBps, uint256 ethOut, uint256 mcapUsd8)",
  ),
  parseAbiItem("event FeesCollected(uint256 fees0, uint256 fees1, uint256 skim0, uint256 skim1)"),
  parseAbiItem(
    "event PositionLocked(address indexed token, uint256 indexed lockTokenId, address indexed owner, address vault, uint64 startUnlock, uint64 finishUnlock, uint256 initialAmount, uint256 feeAmount)",
  ),
] as const;

/* ------------------------------ metadata ------------------------------- */

type PadMeta = { sym: string; decimals: number };

async function loadPadMap(): Promise<Map<string, PadMeta>> {
  const floor = await getJson<{
    rows?: Array<{ lane?: { pad?: string; quoteSymbol?: string; quoteDecimals?: number } | null }>;
  }>(`${SB}/floor`, 15_000);
  const pads = new Map<string, PadMeta>();
  pads.set(ETH_PAD, { sym: "ETH", decimals: 18 });
  for (const r of floor.rows ?? []) {
    const lane = r.lane;
    if (lane?.pad) {
      pads.set(lane.pad.toLowerCase(), {
        sym: lane.quoteSymbol ?? "ETH",
        decimals: lane.quoteDecimals ?? 18,
      });
    }
  }
  return pads;
}

const lensAbi = [
  {
    type: "function",
    name: "viewAll",
    stateMutability: "view",
    inputs: [{ name: "registry", type: "address" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "vault", type: "address" },
          { name: "pool", type: "address" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "symbol0", type: "string" },
          { name: "symbol1", type: "string" },
          { name: "decimals0", type: "uint8" },
          { name: "decimals1", type: "uint8" },
          { name: "mode", type: "uint8" },
          { name: "baseIsToken0", type: "bool" },
          { name: "poolFee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "spotTick", type: "int24" },
          { name: "positionId", type: "uint256" },
          { name: "totalSupply", type: "uint256" },
          { name: "totalValueQuote", type: "uint256" },
          { name: "tvOk", type: "bool" },
          { name: "capQuote", type: "uint256" },
          { name: "maxCapQuote", type: "uint256" },
          { name: "perfFeeBps", type: "uint16" },
          { name: "withdrawFeeBps", type: "uint16" },
          { name: "depositsPaused", type: "bool" },
          { name: "settled", type: "bool" },
          { name: "allBase", type: "bool" },
          { name: "lastRecenterAt", type: "uint64" },
          { name: "feeManager", type: "address" },
        ],
      },
    ],
  },
] as const;

/** Per vault pricing data: quote side + spot tick to convert the base side. */
type VaultMeta = {
  quoteIs0: boolean;
  quoteSym: string;
  quoteDec: number;
  spotTick: number;
};

async function loadVaultMap(): Promise<Map<string, VaultMeta>> {
  const views = await client.readContract({
    address: LENS,
    abi: lensAbi,
    functionName: "viewAll",
    args: [REGISTRY],
  });
  const map = new Map<string, VaultMeta>();
  for (const v of views) {
    const quoteIs0 = !v.baseIsToken0;
    map.set(v.vault.toLowerCase(), {
      quoteIs0,
      quoteSym: quoteIs0 ? v.symbol0 : v.symbol1,
      quoteDec: quoteIs0 ? v.decimals0 : v.decimals1,
      spotTick: Number(v.spotTick),
    });
  }
  return map;
}

async function loadEthUsd(): Promise<number | null> {
  const fromLlama = await getJson<{ coins?: Record<string, { price?: number }> }>(LLAMA_ETH)
    .then((r) => r.coins?.["coingecko:ethereum"]?.price ?? null)
    .catch(() => null);
  if (fromLlama !== null) return fromLlama;
  return getJson<{ ethUsd?: number }>(`${SB}/stats`, 12_000)
    .then((r) => (typeof r.ethUsd === "number" ? r.ethUsd : null))
    .catch(() => null);
}

type LlamaSummary = { total24h?: number | null; total7d?: number | null };

async function loadBlend(): Promise<{
  fees24h: number | null;
  fees7d: number | null;
  revenue24h: number | null;
  revenue7d: number | null;
  volume24h: number | null;
  volume7d: number | null;
}> {
  const [fees, revenue, dex] = await Promise.all([
    getJson<LlamaSummary>(`${LLAMA}/summary/fees/stonkbrokers`, 15_000).catch(() => null),
    getJson<LlamaSummary>(`${LLAMA}/summary/fees/stonkbrokers?dataType=dailyRevenue`, 15_000).catch(() => null),
    getJson<LlamaSummary>(`${LLAMA}/summary/dexs/clutch-anvil-amm`, 15_000).catch(() => null),
  ]);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    fees24h: num(fees?.total24h),
    fees7d: num(fees?.total7d),
    revenue24h: num(revenue?.total24h),
    revenue7d: num(revenue?.total7d),
    volume24h: num(dex?.total24h),
    volume7d: num(dex?.total7d),
  };
}

/* ----------------------------- scan buckets ----------------------------- */

const SURFACES = ["activations", "anvil_swaps", "loans", "launchpad_tax", "smart_lp", "vesting"] as const;
type SurfaceKey = (typeof SURFACES)[number];

type Slot = {
  events: number;
  /** ETH denominated fees (activation/swap/loan + ETH pad taxes). */
  feeEth: number;
  /** USD priced at scan time (Smart LP collections, spot converted). */
  usdScan: number;
  /** Smart LP protocol skim, USD at scan time (subset of usdScan). */
  usdSkim: number;
  /** Quote token amounts from quoted lane pads, by symbol. */
  native: Record<string, number>;
};

type Bucket = Record<SurfaceKey, Slot>;

function emptySlot(): Slot {
  return { events: 0, feeEth: 0, usdScan: 0, usdSkim: 0, native: {} };
}

function emptyBucket(): Bucket {
  return {
    activations: emptySlot(),
    anvil_swaps: emptySlot(),
    loans: emptySlot(),
    launchpad_tax: emptySlot(),
    smart_lp: emptySlot(),
    vesting: emptySlot(),
  };
}

const CHUNK = 80_000n;
const MAX_FWD_CHUNKS = 6;
// Production lambdas are usually cold (module scan state does not survive between
// polls), so a single pass must be able to reach the full 7d window on its own.
// The PASS_BUDGET_MS gate below still bounds worst case latency; a pass that runs
// out of budget keeps honest partial coverage flags.
const MAX_BACK_CHUNKS = 100;
const PASS_BUDGET_MS = 38_000;
const HOUR_MS = 3_600_000;
const D7_MS = 7 * 24 * HOUR_MS;
/** Scan floor: 7d plus margin so the d7 window is fully inside coverage. */
const BACKFILL_MS = D7_MS + 3 * HOUR_MS;

/** Module scan state: contiguous window [low, high] + hourly buckets.
 * low === high + 1n means nothing scanned yet. */
const state: {
  high: bigint;
  low: bigint;
  buckets: Map<number, Bucket>;
  anchor: { block: number; tsMs: number; msPerBlock: number } | null;
} = { high: 0n, low: 0n, buckets: new Map(), anchor: null };

/** Two point block/time anchor for block -> timestamp estimation. */
async function refreshAnchor(head: bigint): Promise<void> {
  const span = head > 600_000n ? 600_000n : head / 2n;
  const [a, b] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: head - span }),
  ]);
  const msPerBlock = (Number(a.timestamp - b.timestamp) * 1000) / Number(span);
  state.anchor = {
    block: Number(head),
    tsMs: Number(a.timestamp) * 1000,
    msPerBlock: msPerBlock > 0 ? msPerBlock : 100,
  };
}

function tsOfBlock(block: number): number {
  const a = state.anchor;
  if (!a) return Date.now();
  return a.tsMs - (a.block - block) * a.msPerBlock;
}

function blockAtTs(tsMs: number): bigint {
  const a = state.anchor;
  if (!a) return 0n;
  const b = a.block - Math.ceil((a.tsMs - tsMs) / a.msPerBlock);
  return b > 0 ? BigInt(b) : 0n;
}

function slotFor(block: number, surface: SurfaceKey): Slot {
  const key = Math.floor(tsOfBlock(block) / HOUR_MS);
  let bucket = state.buckets.get(key);
  if (!bucket) {
    bucket = emptyBucket();
    state.buckets.set(key, bucket);
  }
  return bucket[surface];
}

function pruneBuckets(): void {
  const floorKey = Math.floor((Date.now() - BACKFILL_MS - 6 * HOUR_MS) / HOUR_MS);
  for (const key of state.buckets.keys()) if (key < floorKey) state.buckets.delete(key);
}

/** Spot convert a Smart LP fee pair (raw amounts) into quote units. */
function pairToQuoteRaw(meta: VaultMeta, amt0: number, amt1: number): number {
  const p = Math.pow(1.0001, meta.spotTick); // raw token1 per raw token0
  return meta.quoteIs0 ? amt0 + (p > 0 ? amt1 / p : 0) : amt1 + amt0 * p;
}

function quoteUsd(sym: string, units: number, ethUsd: number | null): number | null {
  if (sym === "USDG") return units;
  if (sym === "WETH" || sym === "ETH") return ethUsd !== null ? units * ethUsd : null;
  return null;
}

type ScanLog = {
  eventName: string;
  address: string;
  blockNumber: bigint;
  args: Record<string, unknown>;
};

function applyLog(
  log: ScanLog,
  pads: Map<string, PadMeta>,
  vaults: Map<string, VaultMeta>,
  ethUsd: number | null,
): void {
  const block = Number(log.blockNumber);
  const addr = log.address.toLowerCase();
  const arg = (k: string): number => {
    const v = log.args[k];
    return typeof v === "bigint" ? Number(v) : 0;
  };

  switch (log.eventName) {
    case "ActivationEthFeePaid": {
      const s = slotFor(block, "activations");
      s.events += 1;
      s.feeEth += arg("amount") / 1e18;
      return;
    }
    case "RobinhoodSwapFeePaid": {
      const s = slotFor(block, "anvil_swaps");
      s.events += 1;
      s.feeEth += arg("feeWei") / 1e18;
      return;
    }
    case "LoanEthFeePaid": {
      const s = slotFor(block, "loans");
      s.events += 1;
      s.feeEth += arg("amount") / 1e18;
      return;
    }
    case "SafeBuy":
    case "SafeSell": {
      const pad = pads.get(addr);
      if (!pad) return; // same topic from an unknown contract: not a pad
      const s = slotFor(block, "launchpad_tax");
      s.events += 1;
      const tax = arg("taxPaid") / Math.pow(10, pad.decimals);
      if (pad.sym === "ETH" || pad.sym === "WETH") s.feeEth += tax;
      else s.native[pad.sym] = (s.native[pad.sym] ?? 0) + tax;
      return;
    }
    case "FeesCollected": {
      const meta = vaults.get(addr);
      if (!meta) return; // not a registered Smart LP vault
      const s = slotFor(block, "smart_lp");
      s.events += 1;
      const feeQ = pairToQuoteRaw(meta, arg("fees0"), arg("fees1")) / Math.pow(10, meta.quoteDec);
      const skimQ = pairToQuoteRaw(meta, arg("skim0"), arg("skim1")) / Math.pow(10, meta.quoteDec);
      s.usdScan += quoteUsd(meta.quoteSym, feeQ, ethUsd) ?? 0;
      s.usdSkim += quoteUsd(meta.quoteSym, skimQ, ethUsd) ?? 0;
      return;
    }
    case "PositionLocked": {
      if (addr !== VESTING_LOCKER) return;
      const s = slotFor(block, "vesting");
      s.events += 1;
      // feeAmount is 1 bps of the locked token, priced token by token
      // nowhere public - counted, not USD priced.
      return;
    }
  }
}

async function scanRange(
  fromBlock: bigint,
  toBlock: bigint,
  pads: Map<string, PadMeta>,
  vaults: Map<string, VaultMeta>,
  ethUsd: number | null,
): Promise<boolean> {
  let logs;
  try {
    logs = await client.getLogs({
      events: EVENTS,
      fromBlock,
      toBlock,
      strict: false,
    });
  } catch {
    return false; // caller keeps its bound - the range replays next pass
  }
  for (const log of logs) {
    try {
      if (log.eventName) applyLog(log as unknown as ScanLog, pads, vaults, ethUsd);
    } catch {
      /* one undecodable log never kills the pass */
    }
  }
  return true;
}

async function scanPass(
  pads: Map<string, PadMeta>,
  vaults: Map<string, VaultMeta>,
  ethUsd: number | null,
): Promise<void> {
  const started = Date.now();
  const head = await client.getBlockNumber();
  if (!state.anchor || Number(head) - state.anchor.block > 40_000) await refreshAnchor(head);
  if (state.high === 0n) {
    state.high = head;
    state.low = head + 1n;
  }

  // 1) Forward catch up toward head (bounded).
  for (let i = 0; i < MAX_FWD_CHUNKS && state.high < head; i++) {
    if (Date.now() - started > PASS_BUDGET_MS) return;
    const start = state.high + 1n;
    const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
    if (!(await scanRange(start, end, pads, vaults, ethUsd))) return;
    state.high = end;
  }

  // 2) Backward seed toward the 7d floor (bounded chunks per request).
  const floor = blockAtTs(Date.now() - BACKFILL_MS);
  for (let i = 0; i < MAX_BACK_CHUNKS && state.low > floor + 1n; i++) {
    if (Date.now() - started > PASS_BUDGET_MS) return;
    const end = state.low - 1n;
    const start = end - CHUNK + 1n > floor ? end - CHUNK + 1n : floor;
    if (!(await scanRange(start, end, pads, vaults, ethUsd))) return;
    state.low = start;
  }
  pruneBuckets();
}

/* -------------------------------- serve --------------------------------- */

type WindowOut = {
  events: number;
  feeEth: number;
  feeUsd: number | null;
  usdSkim?: number;
  native?: Record<string, number>;
};

const SURFACE_INFO: Record<SurfaceKey, { label: string; note: string }> = {
  activations: {
    label: "Broker activations",
    note: "Anvil soft staking activation ETH fee, 100% to the treasury (the 95% collection token burn is on top, not counted here). Revenue share ~100%.",
  },
  anvil_swaps: {
    label: "Anvil AMM NFT swaps",
    note: "Flat ~$2 ETH fee per NFT swap, split $1 treasury / $1 StockBooster. Revenue share ~50%.",
  },
  loans: {
    label: "Anvil loans",
    note: "Flat ~$2 ETH fee per borrow, 100% treasury. Revenue share ~100%.",
  },
  launchpad_tax: {
    label: "Stonklauncher trade taxes",
    note: "SafeBuy/SafeSell taxPaid across every pad. ETH pads priced in USD; quoted lanes report native quote amounts (WETH/USDG priced, other quotes listed unpriced).",
  },
  smart_lp: {
    label: "Smart LP collections",
    note: "FeesCollected across registered vaults, spot priced into each vault's quote token. usdSkim is the 10% protocol take inside feeUsd.",
  },
  vesting: {
    label: "Vesting locker deposits",
    note: "PositionLocked count. The 1 bps deposit fee is paid in the locked token and is not USD priced here.",
  },
};

function windowOut(slots: Slot[], ethUsd: number | null): WindowOut {
  const sum = emptySlot();
  for (const s of slots) {
    sum.events += s.events;
    sum.feeEth += s.feeEth;
    sum.usdScan += s.usdScan;
    sum.usdSkim += s.usdSkim;
    for (const [sym, amt] of Object.entries(s.native)) {
      sum.native[sym] = (sum.native[sym] ?? 0) + amt;
    }
  }
  let feeUsd: number | null = sum.usdScan;
  if (sum.feeEth > 0) {
    if (ethUsd === null) feeUsd = sum.usdScan > 0 ? sum.usdScan : null;
    else feeUsd += sum.feeEth * ethUsd;
  }
  const nativeOut: Record<string, number> = {};
  for (const [sym, amt] of Object.entries(sum.native)) {
    const priced = quoteUsd(sym, amt, ethUsd);
    if (priced !== null && feeUsd !== null) feeUsd += priced;
    else nativeOut[sym] = amt;
  }
  const out: WindowOut = {
    events: sum.events,
    feeEth: Math.round(sum.feeEth * 1e6) / 1e6,
    feeUsd: feeUsd === null ? null : Math.round(feeUsd * 100) / 100,
  };
  if (sum.usdSkim > 0) out.usdSkim = Math.round(sum.usdSkim * 100) / 100;
  if (Object.keys(nativeOut).length > 0) out.native = nativeOut;
  return out;
}

function buildResponse(ethUsd: number | null, blend: Awaited<ReturnType<typeof loadBlend>>) {
  const now = Date.now();
  const d1From = now - 24 * HOUR_MS;
  const d7From = now - D7_MS;
  const scannedFromTs = state.low <= state.high ? tsOfBlock(Number(state.low)) : now;

  const surfaces = SURFACES.map((key) => {
    const d1Slots: Slot[] = [];
    const d7Slots: Slot[] = [];
    for (const [hourKey, bucket] of state.buckets) {
      const ts = hourKey * HOUR_MS + HOUR_MS / 2; // bucket midpoint
      if (ts >= d7From) d7Slots.push(bucket[key]);
      if (ts >= d1From) d1Slots.push(bucket[key]);
    }
    return {
      key,
      label: SURFACE_INFO[key].label,
      note: SURFACE_INFO[key].note,
      d1: windowOut(d1Slots, ethUsd),
      d7: windowOut(d7Slots, ethUsd),
    };
  });

  const sumUsd = (w: "d1" | "d7") => surfaces.reduce((acc, s) => acc + (s[w].feeUsd ?? 0), 0);

  // The DefiLlama fees adapter counts every surface scanned here PLUS
  // several this feed does not scan: the protocol owned Uniswap v4
  // STONK/ETH forever escrow position's LP fee income (attributed per
  // swap, 100% revenue side, no matching volume in the dex adapter),
  // locked LP fee claims through the Safety Deposit Box lockers, Broker
  // Box (parked), the Relay swap desk app fee, and a small Base chain
  // component. The residual is dominated by those, so it is reported
  // honestly rather than forced to zero.
  const surfaceSum24h = Math.round(sumUsd("d1") * 100) / 100;
  const unattributedUsd =
    blend.fees24h !== null ? Math.round((blend.fees24h - surfaceSum24h) * 100) / 100 : null;

  return {
    ethUsd,
    coverage: {
      headBlock: Number(state.high),
      scannedFromBlock: state.low <= state.high ? Number(state.low) : null,
      scannedFromTs: Math.round(scannedFromTs),
      d1Complete: scannedFromTs <= d1From,
      d7Complete: scannedFromTs <= d7From,
      note: "Progressive backfill: a cold instance covers ~24h in one or two polls and deepens toward 7d on later polls. Windows with complete=false undercount.",
    },
    windows: {
      d1: { fromTs: d1From, complete: scannedFromTs <= d1From },
      d7: { fromTs: d7From, complete: scannedFromTs <= d7From },
    },
    surfaces,
    blended: {
      llamaFees24h: blend.fees24h,
      llamaFees7d: blend.fees7d,
      llamaRevenue24h: blend.revenue24h,
      llamaRevenue7d: blend.revenue7d,
      llamaVolume24h: blend.volume24h,
      llamaVolume7d: blend.volume7d,
      surfaceSum24h,
      unattributedUsd,
      note: "unattributedUsd = llamaFees24h minus surfaceSum24h. The residual is dominated by fee surfaces this feed does not scan: the protocol owned Uniswap v4 STONK/ETH LP position's fee income (per swap attribution, 100% revenue side, no matching volume in the dex adapter), locked LP fee claims through the Safety Deposit Box lockers, the Relay swap desk app fee, and a small Base component. That volume-less, all-revenue LP income is the main reason blended revenue/fees runs ~70% while onchain surface fees look 50/50.",
    },
  };
}

/* --------------------------------- route -------------------------------- */

async function load() {
  const [padsRes, vaultsRes, ethUsdRes, blendRes] = await Promise.all([
    cached("feebd:pads", 600_000, loadPadMap),
    cached("feebd:vaults", 600_000, loadVaultMap),
    cached("feebd:ethusd", 300_000, loadEthUsd),
    cached("feebd:blend", 600_000, loadBlend),
  ]);
  await scanPass(padsRes.data, vaultsRes.data, ethUsdRes.data);
  return buildResponse(ethUsdRes.data, blendRes.data);
}

export async function GET() {
  try {
    const { data, stale, at } = await cached("feebd:scan", 300_000, load);
    return feedResponse({ ok: true, updatedAt: at, stale, ...data }, 60);
  } catch (err) {
    return feedError(err instanceof Error ? err.message : "fee breakdown feed failed");
  }
}
