/**
 * Read/write function digest of a contract ABI, for the explainer a stranger
 * needs: which functions only read state (free, no wallet), which ones write
 * it (a transaction from a connected wallet), with their arguments and
 * returns. Shared by the contract page on LAURA's site, the announcement
 * prompt and the deterministic fallback reply.
 */

export interface AbiParam {
  name: string;
  type: string;
}

export interface AbiFunction {
  name: string;
  /** name(type name, ...) as a human reads it */
  signature: string;
  inputs: AbiParam[];
  outputs: AbiParam[];
  mutability: "view" | "pure" | "nonpayable" | "payable";
}

export interface FunctionDigest {
  reads: AbiFunction[];
  writes: AbiFunction[];
}

interface RawParam {
  name?: string;
  type?: string;
  internalType?: string;
}
interface RawItem {
  type?: string;
  name?: string;
  inputs?: RawParam[];
  outputs?: RawParam[];
  stateMutability?: string;
  constant?: boolean;
}

function param(p: RawParam): AbiParam {
  const internal = typeof p.internalType === "string" ? p.internalType : "";
  const type = internal.startsWith("struct ") ? internal.replace(/^struct\s+\w+\./, "").replace(/^struct\s+/, "") : (p.type ?? "unknown");
  return { name: p.name ?? "", type };
}

export function functionDigest(abi: unknown[]): FunctionDigest {
  const reads: AbiFunction[] = [];
  const writes: AbiFunction[] = [];
  for (const raw of abi) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as RawItem;
    if (item.type !== "function" || !item.name) continue;
    const inputs = (item.inputs ?? []).map(param);
    const outputs = (item.outputs ?? []).map(param);
    const mut = item.stateMutability ?? (item.constant ? "view" : "nonpayable");
    const mutability: AbiFunction["mutability"] =
      mut === "view" || mut === "pure" || mut === "payable" ? mut : "nonpayable";
    const fn: AbiFunction = {
      name: item.name,
      signature: `${item.name}(${inputs.map((i) => (i.name ? `${i.type} ${i.name}` : i.type)).join(", ")})`,
      inputs,
      outputs,
      mutability,
    };
    (mutability === "view" || mutability === "pure" ? reads : writes).push(fn);
  }
  const byName = (a: AbiFunction, b: AbiFunction) => a.name.localeCompare(b.name);
  reads.sort(byName);
  writes.sort(byName);
  return { reads, writes };
}

/** Compact text of the digest for a prompt (one line per function). */
export function digestText(d: FunctionDigest): string {
  const line = (f: AbiFunction) =>
    `${f.signature}${f.outputs.length ? ` -> ${f.outputs.map((o) => (o.name ? `${o.type} ${o.name}` : o.type)).join(", ")}` : ""}${f.mutability === "payable" ? " [payable: sends native coin]" : ""}`;
  return [
    `READ (free, no wallet; the explorer's Read tab): ${d.reads.length ? d.reads.map(line).join(" | ") : "none"}`,
    `WRITE (a transaction from a connected wallet; the explorer's Write tab): ${d.writes.length ? d.writes.map(line).join(" | ") : "none"}`,
  ].join("\n");
}

/** Constants and getters the explainer can skip: auto-generated public storage of ALL_CAPS names. */
export function isConstantGetter(f: AbiFunction): boolean {
  return f.inputs.length === 0 && /^[A-Z][A-Z0-9_]+$/.test(f.name);
}
