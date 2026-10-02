/**
 * Uniswap V3 / Slipstream tick arithmetic, exact bigint port of TickMath so
 * the pool is initialised at precisely the tick the single sided position
 * expects (float sqrt at the 2^96 scale can land one tick off, which turns a
 * token only position into one that needs a sliver of WETH and reverts).
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const MAX_UINT256 = (1n << 256n) - 1n;

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Tick whose price is at or just below `price` (token1 per token0, raw units). */
export function priceToTick(price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error(`bad price ${price}`);
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

/** Nearest tick that is a multiple of `spacing`, clamped to the usable range. */
export function alignTick(tick: number, spacing: number, mode: "nearest" | "down" | "up" = "nearest"): number {
  const q = tick / spacing;
  const n = mode === "down" ? Math.floor(q) : mode === "up" ? Math.ceil(q) : Math.round(q);
  const limit = Math.floor(MAX_TICK / spacing) * spacing;
  return Math.max(-limit, Math.min(limit, n * spacing));
}

export interface SingleSidedRange {
  /** Sorted pool tokens */
  token0: `0x${string}`;
  token1: `0x${string}`;
  /** True when the launched token is token0 (its address sorts below WETH) */
  tokenIsToken0: boolean;
  tickLower: number;
  tickUpper: number;
  /** Tick the pool is initialised at: one tick outside the range on the token side */
  initTick: number;
  sqrtPriceX96: bigint;
}

/**
 * Builds a token only position that starts at `startPriceWethPerToken` and
 * runs up to `topPriceWethPerToken`. The pool opens one tick outside the
 * range on the token side, so the position needs no WETH and the first buy
 * steps straight into it. Both tokens are 18 decimals, so the raw ratio
 * equals the human price.
 */
export function singleSidedRange(
  token: `0x${string}`,
  weth: `0x${string}`,
  startPriceWethPerToken: number,
  topPriceWethPerToken: number,
  spacing: number,
): SingleSidedRange {
  if (!(topPriceWethPerToken > startPriceWethPerToken)) throw new Error("range top must be above the start price");
  const tokenIsToken0 = token.toLowerCase() < weth.toLowerCase();
  const [token0, token1] = tokenIsToken0 ? [token, weth] : [weth, token];
  if (tokenIsToken0) {
    /* price = WETH per token; the token side of the range is ABOVE the current tick */
    const tickLower = alignTick(priceToTick(startPriceWethPerToken), spacing);
    let tickUpper = alignTick(priceToTick(topPriceWethPerToken), spacing, "up");
    if (tickUpper <= tickLower) tickUpper = tickLower + spacing;
    const initTick = tickLower - 1;
    return { token0, token1, tokenIsToken0, tickLower, tickUpper, initTick, sqrtPriceX96: getSqrtRatioAtTick(initTick) };
  }
  /* price = tokens per WETH; a dearer token is a LOWER tick, so the range sits BELOW the current tick */
  const tickUpper = alignTick(priceToTick(1 / startPriceWethPerToken), spacing);
  let tickLower = alignTick(priceToTick(1 / topPriceWethPerToken), spacing, "down");
  if (tickLower >= tickUpper) tickLower = tickUpper - spacing;
  const initTick = tickUpper + 1;
  return { token0, token1, tokenIsToken0, tickLower, tickUpper, initTick, sqrtPriceX96: getSqrtRatioAtTick(initTick) };
}
