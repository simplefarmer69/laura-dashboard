import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  hexToBigInt,
  http,
  keccak256,
  parseAbi,
  parseEther,
} from "viem";
import { ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { QUOTE_TOKENS } from "@/lib/launchpad/earnings";
import { getAccount } from "@/lib/launchpad/service";
import { TREASURY_CAPS, NIGHTSHADES_CAPS, maxSnipeTaxBpsFor, nightshadesEligibility, openNightshadesPositions, type NightshadesHolding } from "@/lib/launchpad/treasury-caps";
import { loadState, newId, pushEvent, updateState } from "@/lib/store";
import type { NightshadesFactionId, NightshadesTrade, SwarmState } from "@/lib/types";

/**
 * Nightshades: Purser's hands on the four faction tokens of the Meebco Labs x
 * Clutch Markets survival game on Robinhood Chain (operator grant 2026-09-15:
 * "allow laura to also trade on the nightshades faction tokens"). The game is
 * documented for every agent in library/88-nightshades.md; this module is the
 * wire.
 *
 * Where the tokens trade now: all four launched on the StonkLauncher's
 * Nightshades pad (CivAntiSnipePad) on 2026-09-14 and bonded the same day into
 * protocol-owned Uniswap v4 pools against WETH, each hooked by the game's
 * NightHook (1% pool fee, EOA-only senders, trading halted while a Night
 * resolves, a 99%->0% anti-snipe tax for the 60 minutes after). The game
 * frontends trade through one router, so does Purser:
 *
 *   router.buyExactIn(factionId, wethIn, minTokenOut, to)   WETH -> faction token
 *   router.sellExactIn(factionId, tokenIn, minWethOut, to)  faction token -> WETH
 *   quoter.quoteExactInput(factionId, isBuy, amountIn)      read-only quote
 *
 * Addresses and ABIs were lifted from the two live frontends (stonkbrokers.io
 * /safe-launch/nightshades and nightshades.meebco.com) and confirmed against
 * the chain: vault.factionIds() returns the four ids below, the poolId derived
 * from vault.faction(id).key matches the game API's, and the slot0 price read
 * here matches the API's price to the last digit. The router, hook, manager
 * and vault are not source-verified on Blockscout (only the tokens are), which
 * is one more reason the caps stay small.
 *
 * Every trade is simulate-first and hard-capped (NIGHTSHADES_CAPS), refused in
 * code while a Night is resolving or while the Sunrise tax is above 1%, and
 * never touches $STONKBROKER or LAURA's own launches (different rail entirely).
 */

export const NIGHTSHADES = {
  chainId: 4663,
  site: "https://nightshades.meebco.com",
  nightpaper: "https://nightshades.meebco.com/nightpaper",
  api: "https://nightshadesapi.meebits.com/api",
  tradePage: "https://stonkbrokers.io/safe-launch/nightshades",
  anvil: "https://anvil.clutch.market",
  /** Custom launch pad the four tokens launched on (buys only, wallets only, 99% -> 0% tax over 99 minutes). */
  pad: "0xca389585c4940B107D49AF4A37aD259c5fb69081" as `0x${string}`,
  /** The game's swap router over the hooked v4 pools. */
  router: "0xFa7fBf829889Eb811E467B1433aB692Cb6A5d5b4" as `0x${string}`,
  /** Read-only quoter for the router's two swaps. */
  quoter: "0xc25def789B25de0a7Be3A39D651BB98b7f760C2a" as `0x${string}`,
  /** Protocol-owned liquidity vault: sole LP of the four game pools, holds the Night boost pot. */
  vault: "0xfff716727d7E80E29eab5D3498b7F28431e65C58" as `0x${string}`,
  /** NightHook on every game pool: curfew, EOA gate, Sunrise tax. */
  hook: "0x065388FA59505ceF471529FFa08d7EcfaB1fAACc" as `0x${string}`,
  /** Night manager: schedule, VRF outcome, damaged/survivor sets. */
  manager: "0x999bF370F09Fc776056a99bc532d0650517D8C72" as `0x${string}`,
  /** Uniswap v4 PoolManager on Robinhood Chain. */
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as `0x${string}`,
  weth: QUOTE_TOKENS.weth.address as `0x${string}`,
} as const;

export interface NightshadesFaction {
  id: NightshadesFactionId;
  name: string;
  symbol: string;
  /** bytes32 faction id used by the router, quoter, vault and manager (the upper-case name, right-padded). */
  factionId: `0x${string}`;
  token: `0x${string}`;
  nft: `0x${string}`;
  /** AnvilAMM market that swaps between the faction's NFTs and its token (tokensPerNft 1,000,000). */
  anvilMarket: `0x${string}`;
  /** The launch pad's launch id on the Nightshades pad */
  launchId: number;
  /** The Nightpaper's one-line character of the faction (flavour, not mechanics) */
  tagline: string;
}

export const NIGHTSHADES_FACTIONS: readonly NightshadesFaction[] = [
  {
    id: "ghosts",
    name: "Ghosts",
    symbol: "GHST",
    factionId: "0x47484f5354530000000000000000000000000000000000000000000000000000",
    token: "0xd6b619A75667Cfcc827A3b9B75D807D98b5456d2",
    nft: "0x7Cd6e36286F92F55CC8F498E36e10A975A332AAC",
    anvilMarket: "0x5c13f5f4Bc85205e3aAb278f7007b1C17BC958ea",
    launchId: 1,
    tagline: "Evasive liquidity, high volatility, strongest during recovery windows.",
  },
  {
    id: "watchers",
    name: "Watchers",
    symbol: "WATCH",
    factionId: "0x5741544348455253000000000000000000000000000000000000000000000000",
    token: "0x4FfefDfEfC16daAC253140125f50D8be9bAfFa52",
    nft: "0x291CBcd1e9f44724Ed5aCbDc6E1dDD72b28f7911",
    anvilMarket: "0x51Bc21f0965eD9344a16C62923af1c68deAf6faB",
    launchId: 2,
    tagline: "Information edge, balanced resilience, steady through uncertain night rolls.",
  },
  {
    id: "knights",
    name: "Knights",
    symbol: "KNGHT",
    factionId: "0x4b4e494748545300000000000000000000000000000000000000000000000000",
    token: "0xB6062468073a43c79cD7fd07Fbe496dA9ef544c3",
    nft: "0x63A405Ef2D9937675925AC8a99CE1694BcFD2922",
    anvilMarket: "0xfd5888E566945d594596BfD6cd60CbbB924553A9",
    launchId: 3,
    tagline: "Defensive liquidity, slower cycles, built for survival when nights get heavy.",
  },
  {
    id: "zombies",
    name: "Zombies",
    symbol: "ZMBI",
    factionId: "0x5a4f4d4249455300000000000000000000000000000000000000000000000000",
    token: "0xE4BEF9d0845a13bD39C57C7ee4463ff5D0cc20B6",
    nft: "0xCC87FF3b3c08fC04C1F60F54989Eb7Dfab3e0b31",
    anvilMarket: "0xf816103F6A9722b9256f3edE7D85D9495E46C32D",
    launchId: 4,
    tagline: "Persistent pressure, aggressive rebounds, thrives after damaged pools reopen.",
  },
];

const FACTION_BY_ID = new Map(NIGHTSHADES_FACTIONS.map((f) => [f.id, f]));
const FACTION_BY_BYTES = new Map(NIGHTSHADES_FACTIONS.map((f) => [f.factionId.toLowerCase(), f]));

export function factionOf(id: string): NightshadesFaction | null {
  return FACTION_BY_ID.get(id.trim().toLowerCase() as NightshadesFactionId) ?? null;
}

/* ---------------------------------- ABIs ---------------------------------- */

const ROUTER_ABI = parseAbi([
  "function buyExactIn(bytes32 factionId, uint256 quoteIn, uint256 minTokenOut, address to) returns (uint256 tokenOut)",
  "function sellExactIn(bytes32 factionId, uint256 tokenIn, uint256 minQuoteOut, address to) returns (uint256 quoteOut)",
  "error MinOutRequired()",
  "error SlippageExceeded()",
  "error TransferFailed()",
  "error ZeroAmount()",
  "error NightCurfew()",
  "error ExactOutputDuringSnipeWindow()",
  "error TickMoveExceeded()",
  "error LiquidityLocked(address sender)",
  "error ContractRecipientBlocked(address to)",
  "error ContractSenderBlocked(address from)",
  "error PoolManagerTransferBlocked()",
]);
const QUOTER_ABI = parseAbi(["function quoteExactInput(bytes32 factionId, bool isBuy, uint128 amountIn) view returns (uint256 amountOut)"]);
const MANAGER_ABI = parseAbi([
  "function nightStatus() view returns (bool night, uint256 lastEndsAt)",
  "function nightDuration() view returns (uint256)",
  "function minNightInterval() view returns (uint256)",
  "function currentNight() view returns ((uint64 roundId, uint40 startedAt, uint40 endsAt, bool armed, bool pullsDone, uint8 magnitude, uint16 pullBps, uint256 quotePulled, uint256 quoteSpent, uint256 sellProceeds, uint256 proceedsDeployed) night, bytes32[] damaged, bytes32[] survivors)",
]);
const HOOK_ABI = parseAbi([
  "function currentSnipeTaxBps() view returns (uint16)",
  "function snipeWindowSecs() view returns (uint32)",
]);
const VAULT_ABI = parseAbi([
  "function faction(bytes32 factionId) view returns (address token, bool tokenIs0, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, int24 tickLower, int24 tickUpper)",
  "function nightBoostPot() view returns (uint256)",
]);
const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 4, retryDelay: 800 }),
});

function walletFor(account: NonNullable<ReturnType<typeof getAccount>>) {
  return createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
}

function log(msg: string): void {
  console.log(`[nightshades ${new Date().toISOString()}] ${msg}`);
}

/* ------------------------------- Game state -------------------------------- */

export interface NightshadesFactionState {
  faction: NightshadesFaction;
  /** Pool spot price, ETH per token (from slot0 of the hooked v4 pool) */
  priceEth: number;
  /** Fully diluted market cap in ETH at the pool price (supply from the game API; null when unknown) */
  mcapEth: number | null;
  /** Game API: pool liquidity in ETH (the API's `tvl` field mirrors market cap; `liquidity.total` is the pool) */
  liquidityEth: number | null;
  /** Game API: 24h volume in ETH */
  volume24hEth: number | null;
  /** Game API: struck by the most recent Night */
  isDamaged: boolean;
  /** Was in the damaged (or survivor) set of the last resolved Night, from the manager */
  lastNight: "damaged" | "survived" | null;
}

export interface NightshadesState {
  fetchedAt: number;
  /** A Night is resolving right now: the router refuses every swap (NightCurfew) */
  nightActive: boolean;
  /** Nights resolved so far */
  nightsResolved: number;
  /** Unix ms of the next scheduled Night per the game API (null when unknown) */
  nextNightAt: number | null;
  /** Unix ms the current or last Night ends/ended (0 before the first) */
  nightEndsAt: number;
  /** Sunrise anti-snipe tax on swaps right now, bps (9900 at reopening, 0 after 60 min) */
  snipeTaxBps: number;
  snipeWindowSecs: number;
  /** WETH the vault has banked to boost the next Night's survivors */
  nightBoostPotEth: number;
  /** The last resolved Night's magnitude (0-255 from VRF) and pull share in bps, when there was one */
  lastNight: { roundId: number; damaged: NightshadesFactionId[]; survivors: NightshadesFactionId[]; pullBps: number; magnitude: number } | null;
  factions: NightshadesFactionState[];
  warnings: string[];
}

interface ApiFaction {
  id?: string;
  price?: number;
  marketCap?: number;
  volume24h?: number;
  isDamaged?: boolean;
  liquidity?: { total?: number };
  clutch?: { marketCapTokens?: number };
}
interface ApiState {
  data?: {
    night?: { active?: boolean; endsAt?: number | null; nextStartsAt?: number | null };
    factions?: ApiFaction[];
  };
}

const STATE_TTL_MS = 60_000;
let stateCache: { at: number; value: NightshadesState } | null = null;

function poolIdOf(key: { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` }): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Uniswap v4 PoolManager keeps `_pools` at storage slot 6; slot0 is the first word of each Pool.State. */
const POOLS_SLOT = 6n;

async function poolPriceEthPerToken(factionId: `0x${string}`): Promise<number> {
  const [token, tokenIs0, key] = await publicClient.readContract({ address: NIGHTSHADES.vault, abi: VAULT_ABI, functionName: "faction", args: [factionId] });
  if (token === "0x0000000000000000000000000000000000000000") throw new Error("faction has no pool yet");
  const stateSlot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolIdOf(key), POOLS_SLOT]));
  const raw = hexToBigInt(await publicClient.readContract({ address: NIGHTSHADES.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [stateSlot] }));
  const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
  const price1Per0 = Number(sqrtPriceX96) ** 2 / 2 ** 192;
  // price1Per0 is currency1 per currency0; WETH is the other currency in every game pool.
  return tokenIs0 ? price1Per0 : 1 / price1Per0;
}

async function fetchApiState(warnings: string[]): Promise<ApiState["data"] | null> {
  try {
    const res = await fetch(`${NIGHTSHADES.api}/state?currency=ETH`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as ApiState;
    return json.data ?? null;
  } catch (err) {
    warnings.push(`game API: ${String(err).slice(0, 120)}`);
    return null;
  }
}

/** One read of the game: Night schedule and state, Sunrise tax, boost pot, per-faction price/TVL/volume. Cached 60s. */
export async function fetchNightshadesState(): Promise<NightshadesState> {
  if (stateCache && Date.now() - stateCache.at < STATE_TTL_MS) return stateCache.value;
  const warnings: string[] = [];
  const [api, status, current, tax, win, pot] = await Promise.all([
    fetchApiState(warnings),
    publicClient.readContract({ address: NIGHTSHADES.manager, abi: MANAGER_ABI, functionName: "nightStatus" }),
    publicClient.readContract({ address: NIGHTSHADES.manager, abi: MANAGER_ABI, functionName: "currentNight" }),
    publicClient.readContract({ address: NIGHTSHADES.hook, abi: HOOK_ABI, functionName: "currentSnipeTaxBps" }),
    publicClient.readContract({ address: NIGHTSHADES.hook, abi: HOOK_ABI, functionName: "snipeWindowSecs" }),
    publicClient.readContract({ address: NIGHTSHADES.vault, abi: VAULT_ABI, functionName: "nightBoostPot" }),
  ]);
  const [night, damaged, survivors] = current;
  const resolved = night.roundId > 0n && night.pullsDone;
  const toIds = (xs: readonly `0x${string}`[]): NightshadesFactionId[] =>
    xs.map((x) => FACTION_BY_BYTES.get(x.toLowerCase())?.id).filter((x): x is NightshadesFactionId => Boolean(x));
  const lastNight = resolved
    ? { roundId: Number(night.roundId), damaged: toIds(damaged), survivors: toIds(survivors), pullBps: Number(night.pullBps), magnitude: Number(night.magnitude) }
    : null;
  const apiByFaction = new Map((api?.factions ?? []).map((f) => [String(f.id ?? "").toLowerCase(), f]));
  const factions = await Promise.all(
    NIGHTSHADES_FACTIONS.map(async (f) => {
      const a = apiByFaction.get(f.id);
      let priceEth = 0;
      try {
        priceEth = await poolPriceEthPerToken(f.factionId);
      } catch (err) {
        warnings.push(`${f.symbol} price: ${String(err).slice(0, 100)}`);
        priceEth = a?.price ?? 0;
      }
      const supplyTokens = a?.clutch?.marketCapTokens;
      return {
        faction: f,
        priceEth,
        mcapEth: supplyTokens && priceEth > 0 ? supplyTokens * priceEth : (a?.marketCap ?? null),
        liquidityEth: a?.liquidity?.total ?? null,
        volume24hEth: a?.volume24h ?? null,
        isDamaged: Boolean(a?.isDamaged),
        lastNight: lastNight ? (lastNight.damaged.includes(f.id) ? "damaged" : lastNight.survivors.includes(f.id) ? "survived" : null) : null,
      } satisfies NightshadesFactionState;
    }),
  );
  const value: NightshadesState = {
    fetchedAt: Date.now(),
    nightActive: status[0],
    nightsResolved: resolved ? Number(night.roundId) : Math.max(0, Number(night.roundId) - 1),
    nextNightAt: api?.night?.nextStartsAt ? Number(api.night.nextStartsAt) * 1000 : null,
    nightEndsAt: Number(status[1]) * 1000,
    snipeTaxBps: Number(tax),
    snipeWindowSecs: Number(win),
    nightBoostPotEth: Number(formatEther(pot)),
    lastNight,
    factions,
    warnings,
  };
  stateCache = { at: Date.now(), value };
  return value;
}

/* --------------------------------- Quotes ---------------------------------- */

/** Router-equivalent quote: WETH in -> tokens out (buy) or tokens in -> WETH out (sell). */
export async function quoteNightshades(faction: NightshadesFaction, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  return publicClient.readContract({ address: NIGHTSHADES.quoter, abi: QUOTER_ABI, functionName: "quoteExactInput", args: [faction.factionId, side === "buy", amountIn] });
}

export interface NightshadesPositionValue extends NightshadesHolding {
  /** Wallet balance right now (the ledger can drift from dust or airdrops) */
  walletTokens: number;
  /** WETH the router would return for the whole wallet balance now (null when unquotable, e.g. during a Night) */
  ethNow: number | null;
  priceEth: number | null;
}

/** Read-only: what selling each held faction position would return right now. */
export async function valueNightshadesPositions(state: SwarmState): Promise<NightshadesPositionValue[]> {
  const account = getAccount();
  const open = openNightshadesPositions(state);
  if (!account || open.length === 0) return [];
  return Promise.all(
    open.map(async (p) => {
      const f = factionOf(p.faction);
      if (!f) return { ...p, walletTokens: 0, ethNow: null, priceEth: null };
      try {
        const bal = await publicClient.readContract({ address: f.token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
        if (bal === 0n) return { ...p, walletTokens: 0, ethNow: 0, priceEth: null };
        const out = await quoteNightshades(f, "sell", bal).catch(() => null);
        const walletTokens = Number(formatEther(bal));
        const ethNow = out === null ? null : Number(formatEther(out));
        return { ...p, walletTokens, ethNow, priceEth: ethNow !== null && walletTokens > 0 ? ethNow / walletTokens : null };
      } catch {
        return { ...p, walletTokens: p.tokens, ethNow: null, priceEth: null };
      }
    }),
  );
}

/* --------------------------------- Trades ---------------------------------- */

export type NightshadesResult =
  | { ok: true; sent: true; trade: NightshadesTrade }
  | { ok: true; sent: false; reason: string }
  | { ok: false; reason: string };

/**
 * The two game-clock guards every swap shares; read fresh (not from the
 * cache) right before sending. The Sunrise ceiling is per side: a buy may pay
 * a late-window tax to reach a struck pool's discount, a sell may not, because
 * the free exit was before the Night (see NIGHTSHADES_CAPS).
 */
async function gameClockGuard(side: "buy" | "sell"): Promise<string | null> {
  const [status, tax] = await Promise.all([
    publicClient.readContract({ address: NIGHTSHADES.manager, abi: MANAGER_ABI, functionName: "nightStatus" }),
    publicClient.readContract({ address: NIGHTSHADES.hook, abi: HOOK_ABI, functionName: "currentSnipeTaxBps" }),
  ]);
  if (status[0]) return `a Night is resolving right now (curfew until ~${new Date(Number(status[1]) * 1000).toISOString().slice(11, 16)}Z); the router refuses every swap until it ends`;
  const ceiling = maxSnipeTaxBpsFor(side);
  if (Number(tax) > ceiling) {
    return `Sunrise anti-snipe tax is ${(Number(tax) / 100).toFixed(2)}% right now, above the ${ceiling / 100}% ceiling for a ${side}; it decays to 0% across the hour after a Night, so wait for it to fall`;
  }
  return null;
}

export interface SunriseWindow {
  /** A Night is resolving; every swap reverts. */
  nightActive: boolean;
  /** Inside the post-Night Sunrise window, where the tax is still decaying. */
  sunriseLive: boolean;
  opensAt: number;
  closesAt: number;
  minutesElapsed: number;
  minutesLeft: number;
  taxBps: number;
  /** Clock time each ceiling is first cleared, from the live tax and the linear decay. */
  clearsAt: { bps: number; at: number; minutesAway: number }[];
  /** Minutes until the next Night, when the game API scheduled one. */
  minutesToNextNight: number | null;
}

/**
 * Where we are in the Night/Sunrise cycle and when each tax ceiling clears.
 *
 * The hook decays the tax linearly from 9900 bps to 0 across snipeWindowSecs,
 * so the moment a ceiling clears is arithmetic, not a guess. Purser runs on a
 * cycle cadence rather than continuously, so it needs the schedule to decide
 * whether the window is worth waiting for.
 */
export function sunriseWindow(game: NightshadesState, now = Date.now()): SunriseWindow {
  const opensAt = game.nightEndsAt;
  const closesAt = opensAt + game.snipeWindowSecs * 1000;
  const sunriseLive = !game.nightActive && now >= opensAt && now < closesAt && game.snipeTaxBps > 0;
  const clearsAt = [2000, 1000, 500, 100]
    .filter((bps) => game.snipeTaxBps > bps)
    .map((bps) => {
      /* Linear decay: the tax hits `bps` when the window has this much left. */
      const msLeftAtClear = (bps / 9900) * game.snipeWindowSecs * 1000;
      const at = closesAt - msLeftAtClear;
      return { bps, at, minutesAway: Math.max(0, (at - now) / 60_000) };
    });
  return {
    nightActive: game.nightActive,
    sunriseLive,
    opensAt,
    closesAt,
    minutesElapsed: Math.max(0, (now - opensAt) / 60_000),
    minutesLeft: Math.max(0, (closesAt - now) / 60_000),
    taxBps: game.snipeTaxBps,
    clearsAt,
    minutesToNextNight: game.nextNightAt ? (game.nextNightAt - now) / 60_000 : null,
  };
}

async function ensureAllowance(
  account: NonNullable<ReturnType<typeof getAccount>>,
  token: `0x${string}`,
  amount: bigint,
): Promise<string | null> {
  const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [account.address, NIGHTSHADES.router] });
  if (allowance >= amount) return null;
  // Exact-amount approvals only: the router is not source-verified, so it never holds a standing allowance.
  const { request } = await publicClient.simulateContract({ account, address: token, abi: ERC20_ABI, functionName: "approve", args: [NIGHTSHADES.router, amount] });
  const tx = await walletFor(account).writeContract(request);
  const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
  if (rc.status !== "success") return `approve reverted: ${tx}`;
  return null;
}

/**
 * Buys `amountEth` worth of a faction token through the game router. Wraps
 * only the ETH the trade is short of in WETH, approves exactly that, quotes,
 * applies the slippage guard, simulates, sends, and books the fill from the
 * real balance delta.
 */
export async function nightshadesBuy(opts: { faction: string; amountEth: number; reason: string; runId: string }): Promise<NightshadesResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const f = factionOf(opts.faction);
  if (!f) return { ok: false, reason: `unknown faction "${opts.faction}"; the four are ghosts, watchers, knights, zombies` };
  const state = await loadState();
  const elig = nightshadesEligibility(state, f.id, "buy");
  if (!elig.eligible) return { ok: true, sent: false, reason: elig.reason };
  const clock = await gameClockGuard("buy");
  if (clock) return { ok: true, sent: false, reason: clock };

  let amountEth = Math.min(opts.amountEth, elig.amountEth, NIGHTSHADES_CAPS.maxEthPerTrade);
  const [ethBal, wethBal] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: NIGHTSHADES.weth, abi: WETH_ABI, functionName: "balanceOf", args: [account.address] }),
  ]);
  const spendable = Number(formatEther(ethBal)) - TREASURY_CAPS.treasuryFloorEth + Number(formatEther(wethBal));
  amountEth = Math.min(amountEth, spendable);
  if (amountEth < NIGHTSHADES_CAPS.minEthPerTrade) {
    return { ok: true, sent: false, reason: `spendable ${Math.max(0, spendable).toFixed(4)} ETH+WETH above the ${TREASURY_CAPS.treasuryFloorEth} ETH floor leaves a buy under the ${NIGHTSHADES_CAPS.minEthPerTrade} dust floor` };
  }
  const quoteIn = parseEther(amountEth.toFixed(18));
  const wallet = walletFor(account);
  if (wethBal < quoteIn) {
    const { request } = await publicClient.simulateContract({ account, address: NIGHTSHADES.weth, abi: WETH_ABI, functionName: "deposit", value: quoteIn - wethBal });
    const tx = await wallet.writeContract(request);
    const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    if (rc.status !== "success") return { ok: false, reason: `WETH deposit reverted: ${tx}` };
  }
  const approveErr = await ensureAllowance(account, NIGHTSHADES.weth, quoteIn);
  if (approveErr) return { ok: false, reason: approveErr };

  const quoted = await quoteNightshades(f, "buy", quoteIn);
  if (quoted === 0n) return { ok: false, reason: "quoter returned zero tokens" };
  const minOut = (quoted * BigInt(10_000 - NIGHTSHADES_CAPS.slippageBps)) / 10_000n;
  const { request } = await publicClient.simulateContract({
    account,
    address: NIGHTSHADES.router,
    abi: ROUTER_ABI,
    functionName: "buyExactIn",
    args: [f.factionId, quoteIn, minOut, account.address],
  });
  const before = await publicClient.readContract({ address: f.token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  const txHash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `buyExactIn reverted: ${txHash}` };
  const after = await publicClient.readContract({ address: f.token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  const game = await fetchNightshadesState().catch(() => null);

  const tokenAmount = Number(formatEther(after - before));
  const trade: NightshadesTrade = {
    id: newId("ns"),
    ts: Date.now(),
    side: "buy",
    faction: f.id,
    token: f.token,
    symbol: f.symbol,
    ethAmount: amountEth,
    tokenAmount,
    priceEth: tokenAmount > 0 ? amountEth / tokenAmount : 0,
    nightRound: game?.nightsResolved ?? 0,
    txHash,
    reason: opts.reason,
  };
  await updateState((s) => {
    s.treasuryNightshadesTrades = [...(s.treasuryNightshadesTrades ?? []), trade];
    pushEvent(s, {
      kind: "treasury.nightshades",
      agentId: "treasurer",
      title: `Purser bought ${tokenAmount.toFixed(0)} $${f.symbol} (Nightshades ${f.name}) for ${amountEth.toFixed(4)} WETH`,
      detail: `${opts.reason} · game router ${NIGHTSHADES.router} · tx ${txHash} · ${game ? `Nights resolved so far: ${game.nightsResolved}; next Night ${game.nextNightAt ? new Date(game.nextNightAt).toISOString().slice(0, 16).replace("T", " ") + "Z" : "unscheduled"}` : "game clock unread"} · 24h spend ${(elig.spent24hEth + amountEth).toFixed(4)}/${NIGHTSHADES_CAPS.maxEthPer24h} WETH · caps: ≤${NIGHTSHADES_CAPS.maxEthPerTrade} WETH/trade, ${NIGHTSHADES_CAPS.perFactionGapHours}h per faction, no trades during a Night or above ${NIGHTSHADES_CAPS.maxSnipeTaxBpsBuy / 100}% Sunrise tax on a buy`,
      refId: trade.id,
    });
  });
  log(`bought ${tokenAmount.toFixed(0)} ${f.symbol} for ${amountEth} WETH (tx ${txHash})`);
  return { ok: true, sent: true, trade };
}

/**
 * Sells `fraction` (0-1] of the wallet's real balance of a held faction token
 * back through the game router for WETH (Purser's unwrap-weth turns it into
 * ETH when wanted). Same guards as the buy side.
 */
export async function nightshadesSell(opts: { faction: string; fraction: number; reason: string; runId: string }): Promise<NightshadesResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const f = factionOf(opts.faction);
  if (!f) return { ok: false, reason: `unknown faction "${opts.faction}"; the four are ghosts, watchers, knights, zombies` };
  const state = await loadState();
  const position = openNightshadesPositions(state).find((p) => p.faction === f.id);
  if (!position) return { ok: true, sent: false, reason: `no open Nightshades position in ${f.name}` };
  const fraction = Math.min(1, Math.max(0, opts.fraction));
  if (fraction === 0) return { ok: true, sent: false, reason: "fraction 0: nothing to sell" };
  const elig = nightshadesEligibility(state, f.id, "sell");
  if (!elig.eligible) return { ok: true, sent: false, reason: elig.reason };
  const clock = await gameClockGuard("sell");
  if (clock) return { ok: true, sent: false, reason: clock };

  const balance = await publicClient.readContract({ address: f.token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  const tokensIn = fraction >= 1 ? balance : (balance * BigInt(Math.round(fraction * 10_000))) / 10_000n;
  if (tokensIn === 0n) return { ok: true, sent: false, reason: `wallet holds no $${f.symbol}` };
  const approveErr = await ensureAllowance(account, f.token, tokensIn);
  if (approveErr) return { ok: false, reason: approveErr };

  const quoted = await quoteNightshades(f, "sell", tokensIn);
  if (quoted === 0n) return { ok: false, reason: "quoter returned zero WETH" };
  const minOut = (quoted * BigInt(10_000 - NIGHTSHADES_CAPS.slippageBps)) / 10_000n;
  const { request } = await publicClient.simulateContract({
    account,
    address: NIGHTSHADES.router,
    abi: ROUTER_ABI,
    functionName: "sellExactIn",
    args: [f.factionId, tokensIn, minOut, account.address],
  });
  const wethBefore = await publicClient.readContract({ address: NIGHTSHADES.weth, abi: WETH_ABI, functionName: "balanceOf", args: [account.address] });
  const txHash = await walletFor(account).writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `sellExactIn reverted: ${txHash}` };
  const wethAfter = await publicClient.readContract({ address: NIGHTSHADES.weth, abi: WETH_ABI, functionName: "balanceOf", args: [account.address] });
  const game = await fetchNightshadesState().catch(() => null);

  const ethAmount = Number(formatEther(wethAfter - wethBefore));
  const tokenAmount = Number(formatEther(tokensIn));
  const trade: NightshadesTrade = {
    id: newId("ns"),
    ts: Date.now(),
    side: "sell",
    faction: f.id,
    token: f.token,
    symbol: f.symbol,
    ethAmount,
    tokenAmount,
    priceEth: tokenAmount > 0 ? ethAmount / tokenAmount : 0,
    nightRound: game?.nightsResolved ?? 0,
    txHash,
    reason: opts.reason,
  };
  await updateState((s) => {
    s.treasuryNightshadesTrades = [...(s.treasuryNightshadesTrades ?? []), trade];
    const h = openNightshadesPositions(s).find((p) => p.faction === f.id);
    pushEvent(s, {
      kind: "treasury.nightshades",
      agentId: "treasurer",
      title: `Purser sold ${tokenAmount.toFixed(0)} $${f.symbol} (Nightshades ${f.name}) for ${ethAmount.toFixed(4)} WETH`,
      detail: `${opts.reason} · game router ${NIGHTSHADES.router} · tx ${txHash} · position cost ${position.ethIn.toFixed(4)} WETH, returned so far ${(position.ethOut + ethAmount).toFixed(4)} WETH${h ? ` · ${h.tokens.toFixed(0)} still held` : " · position closed"} · proceeds sit as WETH until unwrap-weth`,
      refId: trade.id,
    });
  });
  log(`sold ${tokenAmount.toFixed(0)} ${f.symbol} for ${ethAmount.toFixed(4)} WETH (tx ${txHash})`);
  return { ok: true, sent: true, trade };
}

/* --------------------------------- Digest ---------------------------------- */

const fmtEth = (n: number | null, d = 4) => (n === null ? "n/a" : `${n.toFixed(d)} ETH`);

function relTime(ms: number, now: number): string {
  const d = ms - now;
  const abs = Math.abs(d);
  const h = Math.floor(abs / 3600_000);
  const m = Math.floor((abs % 3600_000) / 60_000);
  const span = h > 0 ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}

/**
 * Deterministic digest for the Purser prompt: the game clock, the rules that
 * bind a trade, each faction's live numbers, and LAURA's positions with their
 * sell-now value. Every number Purser may cite about Nightshades comes from
 * here.
 */
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/**
 * The Sunrise line: where the clock is in the Night/Sunrise cycle, and the
 * exact minute each tax ceiling clears. Purser wakes on a cycle cadence, so
 * "the tax is 44% right now" is useless on its own; "10% clears at 15:54Z,
 * nine minutes away" is something it can plan a trade around.
 */
function sunriseLine(game: NightshadesState, now: number): string {
  const w = sunriseWindow(game, now);
  if (w.nightActive) {
    return `- SUNRISE: the Night is still resolving. It ends ~${hhmm(w.opensAt)}Z, and the moment it does the Sunrise window opens at a 99% tax that decays to 0% over ${game.snipeWindowSecs / 60} minutes. Struck pools are at their cheapest the second trading reopens and the tax is worst at exactly that moment; the buy point is late in the window, not at the open.`;
  }
  if (w.sunriseLive) {
    const schedule = w.clearsAt.length
      ? w.clearsAt.map((c) => `${c.bps / 100}% at ${hhmm(c.at)}Z (${c.minutesAway.toFixed(0)}m)`).join(" · ")
      : "every ceiling already cleared";
    return `- SUNRISE IS LIVE: window ${hhmm(w.opensAt)}Z to ${hhmm(w.closesAt)}Z, ${w.minutesElapsed.toFixed(0)}m elapsed, ${w.minutesLeft.toFixed(0)}m left, tax ${(w.taxBps / 100).toFixed(2)}% and falling. Clears: ${schedule}. This is the one hour a day struck pools trade at a discount. A buy costs the tax on top of the pool's 1% fee, so name both against the discount before you spend.`;
  }
  const toNight = w.minutesToNextNight;
  const preNight = toNight !== null && toNight <= 90;
  return `- SUNRISE: not in a window (tax 0%, trading is unrestricted). Last window ran ${hhmm(w.opensAt)}Z to ${hhmm(w.closesAt)}Z; the next opens when the ${game.nextNightAt ? `${hhmm(game.nextNightAt)}Z` : "next"} Night ends, roughly ${game.nextNightAt ? hhmm(game.nextNightAt + 60 * 60_000) : "an hour later"}Z.${
    preNight
      ? ` PRE-NIGHT EXIT WINDOW: the Night is ${toNight.toFixed(0)} minutes out and selling is free right now. Anything you do not want exposed to a strike should leave before it, not after.`
      : toNight !== null
        ? ` The Night is ${(toNight / 60).toFixed(1)}h out; the free exit window is the 90 minutes before it.`
        : ""
  }`;
}

export async function nightshadesDigest(state: SwarmState, now = Date.now()): Promise<string> {
  let game: NightshadesState;
  try {
    game = await fetchNightshadesState();
  } catch (err) {
    return `Nightshades read failed this cycle (${String(err).slice(0, 120)}); ns-buy and ns-sell are off the table until it reads.`;
  }
  const positions = await valueNightshadesPositions(state).catch(() => [] as NightshadesPositionValue[]);
  const byFaction = new Map(positions.map((p) => [p.faction, p]));
  const spent = nightshadesEligibility(state, "ghosts", "buy", now).spent24hEth;
  const lines: string[] = [];
  lines.push(
    `- Clock: ${game.nightActive ? `A NIGHT IS RESOLVING NOW (ends ~${new Date(game.nightEndsAt).toISOString().slice(11, 16)}Z); every swap reverts with NightCurfew until then` : `no Night in progress`} · next Night ${game.nextNightAt ? `${new Date(game.nextNightAt).toISOString().slice(11, 16)}Z (${relTime(game.nextNightAt, now)})` : "unscheduled per the game API"} · Nights resolved so far: ${game.nightsResolved} · Sunrise anti-snipe tax right now ${(game.snipeTaxBps / 100).toFixed(2)}% (buys refused above ${NIGHTSHADES_CAPS.maxSnipeTaxBpsBuy / 100}%, sells above ${NIGHTSHADES_CAPS.maxSnipeTaxBpsSell / 100}%) · vault boost pot ${game.nightBoostPotEth.toFixed(2)} WETH waiting to be added to the next survivors' pools.`,
  );
  lines.push(sunriseLine(game, now));
  if (game.lastNight) {
    lines.push(
      `- Last Night #${game.lastNight.roundId}: damaged ${game.lastNight.damaged.join(", ") || "none"} (${(game.lastNight.pullBps / 100).toFixed(0)}% of their pool liquidity pulled, magnitude ${game.lastNight.magnitude}) · survived ${game.lastNight.survivors.join(", ") || "none"}.`,
    );
  } else {
    lines.push(`- No Night has resolved yet; the first draw is still ahead. Nobody, including the game, knows which factions it strikes.`);
  }
  for (const fs of game.factions) {
    const p = byFaction.get(fs.faction.id);
    const held = p
      ? ` · HELD ${p.walletTokens.toFixed(0)} tokens, cost ${fmtEth(p.ethIn, 5)}, sold back ${fmtEth(p.ethOut, 5)}, sell-now ${fmtEth(p.ethNow, 5)}${p.ethNow !== null ? ` (${p.ethNow + p.ethOut - p.ethIn >= 0 ? "+" : ""}${(p.ethNow + p.ethOut - p.ethIn).toFixed(5)} ETH vs cost)` : ""}, last trade ${relTime(p.lastTs, now)}`
      : "";
    lines.push(
      `- ${fs.faction.name} $${fs.faction.symbol} (faction id "${fs.faction.id}", token ${fs.faction.token}): price ${fs.priceEth > 0 ? fs.priceEth.toExponential(3) : "n/a"} ETH · mcap ${fs.mcapEth === null ? "n/a" : `${fs.mcapEth.toFixed(1)} ETH`} · pool liquidity ${fmtEth(fs.liquidityEth, 1)} · 24h volume ${fmtEth(fs.volume24hEth, 1)}${fs.lastNight ? ` · last Night: ${fs.lastNight.toUpperCase()}` : ""}${fs.isDamaged ? " · currently flagged damaged" : ""}${held}.`,
    );
  }
  lines.push(
    `- Nightshades 24h spend ${spent.toFixed(4)} of ${NIGHTSHADES_CAPS.maxEthPer24h} WETH · ≤${NIGHTSHADES_CAPS.maxEthPerTrade} WETH per buy · ${NIGHTSHADES_CAPS.perFactionGapHours}h between trades on one faction · ${positions.length}/4 factions held · treasury floor ${TREASURY_CAPS.treasuryFloorEth} ETH applies.`,
  );
  if (game.warnings.length > 0) lines.push(`- Read warnings: ${game.warnings.join("; ")}`);
  return lines.join("\n");
}
