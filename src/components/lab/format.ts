import { formatUnits } from "viem";

export function short(address: string | null | undefined, chars = 4): string {
  if (!address) return "—";
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

export function fmtUnits(value: bigint, decimals: number, maxFraction = 6): string {
  const raw = formatUnits(value, decimals);
  const [whole, frac = ""] = raw.split(".");
  const trimmed = frac.replace(/0+$/, "").slice(0, maxFraction);
  const withSep = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${withSep}.${trimmed}` : withSep;
}

export function ago(tsSeconds: number): string {
  if (!tsSeconds) return "—";
  const s = Math.max(0, Math.round(Date.now() / 1000 - tsSeconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function countdown(untilSeconds: number): string {
  const s = Math.max(0, Math.round(untilSeconds - Date.now() / 1000));
  if (s === 0) return "now";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
