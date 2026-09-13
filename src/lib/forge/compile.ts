import { execFile } from "node:child_process";
import path from "node:path";
import { FORGE_CAPS } from "@/lib/forge/caps";

/**
 * Compiles one Anvil contract in a child process (scripts/solc-compile.mjs,
 * solc 0.8.28, optimizer 200 runs, evm paris). The settings are fixed here
 * and in the script, and the verifier resubmits exactly them, so a compile
 * that succeeds here verifies byte-for-byte on the explorer.
 */

/** Long-form compiler version the explorers key on. */
export const FORGE_COMPILER_VERSION = "v0.8.28+commit.7893614a";
export const FORGE_COMPILER_SHORT = "0.8.28+commit.7893614a";
export const FORGE_OPTIMIZER_RUNS = 200;
export const FORGE_EVM_VERSION = "paris";
/** File name inside the standard JSON input; the contract identifier is `${FORGE_SOURCE_FILE}:${name}`. */
export const FORGE_SOURCE_FILE = "Contract.sol";

export interface CompileSuccess {
  ok: true;
  abi: unknown[];
  bytecode: `0x${string}`;
  deployedBytecode: `0x${string}`;
  metadata: string;
  standardJson: unknown;
  compiler: string;
  warnings: string[];
}

export interface CompileFailure {
  ok: false;
  errors: string[];
  warnings: string[];
}

export type CompileResult = CompileSuccess | CompileFailure;

const COMPILE_TIMEOUT_MS = 60_000;

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "solc-compile.mjs");
}

export async function compileSource(source: string, contractName: string): Promise<CompileResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [scriptPath()],
      { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "" } },
      (err, out, errOut) => {
        if (err) reject(new Error(`solc child failed: ${String(err).slice(0, 200)} ${String(errOut).slice(0, 300)}`));
        else resolve(String(out));
      },
    );
    child.stdin?.end(JSON.stringify({ source, contractName }));
  });
  let parsed: CompileResult;
  try {
    parsed = JSON.parse(stdout) as CompileResult;
  } catch {
    throw new Error(`solc child returned unparseable output: ${stdout.slice(0, 200)}`);
  }
  if (parsed.ok) {
    const bytes = (parsed.bytecode.length - 2) / 2;
    if (bytes > FORGE_CAPS.maxBytecodeBytes) {
      return { ok: false, errors: [`creation bytecode is ${bytes} bytes; ceiling ${FORGE_CAPS.maxBytecodeBytes}. Simplify the contract.`], warnings: parsed.warnings };
    }
  }
  return parsed;
}

/** Standard JSON input the verifiers receive; rebuilt from the source so nothing else is trusted. */
export function standardJsonInput(source: string): {
  language: "Solidity";
  sources: Record<string, { content: string }>;
  settings: {
    optimizer: { enabled: boolean; runs: number };
    evmVersion: string;
    metadata: { bytecodeHash: "ipfs" };
    outputSelection: Record<string, Record<string, string[]>>;
  };
} {
  return {
    language: "Solidity",
    sources: { [FORGE_SOURCE_FILE]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: FORGE_OPTIMIZER_RUNS },
      evmVersion: FORGE_EVM_VERSION,
      metadata: { bytecodeHash: "ipfs" },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] } },
    },
  };
}
