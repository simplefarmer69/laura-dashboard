#!/usr/bin/env node
/**
 * Out-of-process Solidity compile for Anvil (src/lib/forge/compile.ts).
 *
 * Reads a JSON job on stdin: { source: string, contractName: string } and
 * writes a JSON result on stdout:
 *   { ok: true, abi, bytecode, deployedBytecode, metadata, standardJson, warnings[] }
 *   { ok: false, errors[], warnings[] }
 *
 * Runs as a child process so the 9 MB soljson binary never enters the Next
 * server bundle and a compiler crash can never take the daemon down. The
 * settings here (0.8.28, optimizer 200 runs, evm paris) are the ones the
 * verifier resubmits, so this file and src/lib/forge/compile.ts must agree.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const FILE = "Contract.sol";

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

const job = JSON.parse(await readStdin());
const input = {
  language: "Solidity",
  sources: { [FILE]: { content: job.source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    metadata: { bytecodeHash: "ipfs" },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const diagnostics = out.errors ?? [];
const errors = diagnostics.filter((e) => e.severity === "error").map((e) => e.formattedMessage ?? e.message);
const warnings = diagnostics.filter((e) => e.severity !== "error").map((e) => e.formattedMessage ?? e.message);
if (errors.length > 0) {
  process.stdout.write(JSON.stringify({ ok: false, errors, warnings }));
  process.exit(0);
}
const contract = out.contracts?.[FILE]?.[job.contractName];
if (!contract) {
  const names = Object.keys(out.contracts?.[FILE] ?? {});
  process.stdout.write(
    JSON.stringify({ ok: false, errors: [`contract ${job.contractName} not found in source (found: ${names.join(", ") || "none"})`], warnings }),
  );
  process.exit(0);
}
process.stdout.write(
  JSON.stringify({
    ok: true,
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    metadata: contract.metadata,
    standardJson: input,
    compiler: solc.version(),
    warnings,
  }),
);
