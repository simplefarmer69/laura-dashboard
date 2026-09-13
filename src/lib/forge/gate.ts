import { FORGE_CAPS } from "@/lib/forge/caps";

/**
 * The source gate: the code-level boundary of what Anvil may put on chain.
 *
 * Anvil writes the Solidity itself (operator directive 2026-09-13), so the
 * safety of the whole rail cannot rest on the prompt. It rests here, on what
 * the compiler is allowed to see. A contract that passes this gate:
 *
 *   - is ONE plain contract in one file, pragma pinned to 0.8.28, no imports,
 *     no interfaces, no libraries, no inheritance, no abstract pieces;
 *   - can never hold or move value: no payable functions, no receive or
 *     fallback, no msg.value, no selfdestruct;
 *   - can never call another contract: no interface types, no low-level
 *     call/delegatecall/staticcall, no transfer/send, no contract creation,
 *     no inline assembly;
 *   - has no privileged role: no owner/admin identifiers, no pause switch,
 *     no upgrade hook. Per-entry authorship (msg.sender == entry.author) is
 *     fine; a contract-wide boss is not;
 *   - is ASCII only (no homoglyph tricks) and within the size ceilings.
 *
 * What is left is what Anvil is for: registries, guestbooks, polls, pledges,
 * commit-reveal games without money, counters, RSVP lists, on-chain notes.
 * Pure state machines anyone can read and write from the explorer.
 */

export interface GateVerdict {
  ok: boolean;
  problems: string[];
}

/** Word-boundary identifiers that end the review on sight. */
const FORBIDDEN_WORDS: Array<[RegExp, string]> = [
  [/\bimport\b/, "import"],
  [/\binterface\b/, "interface (no external calls; the contract must stand alone)"],
  [/\blibrary\b/, "library"],
  [/\babstract\b/, "abstract"],
  [/\bassembly\b/, "inline assembly"],
  [/\bpayable\b/, "payable (Anvil contracts never hold value)"],
  [/\breceive\s*\(/, "receive()"],
  [/\bfallback\s*\(/, "fallback()"],
  [/\bselfdestruct\b/, "selfdestruct"],
  [/\bdelegatecall\b/, "delegatecall"],
  [/\bcallcode\b/, "callcode"],
  [/\bstaticcall\b/, "staticcall"],
  [/\.call\s*[({]/, "low-level call"],
  [/\.transfer\s*\(/, "transfer (value movement)"],
  [/\.send\s*\(/, "send (value movement)"],
  [/\bmsg\.value\b/, "msg.value"],
  [/\btx\.origin\b/, "tx.origin"],
  [/\bcreate2?\s*\(/, "create/create2"],
  [/\bnew\s+[A-Za-z_]\w*\s*\(/, "contract creation with new"],
  [/\bowner\b|\bOwner\b|\b_owner\b|\bonlyOwner\b|\bOwnable\b/, "owner role (no boss address; per-entry authorship is fine)"],
  [/\badmin\b|\bAdmin\b|\bonlyAdmin\b|\bgovernance\b|\bgovernor\b/, "admin/governance role"],
  [/\bpaused\b|\bpause\s*\(|\bunpause\s*\(|\bwhenNotPaused\b/, "pause switch"],
  [/\bupgrade\w*\b|\bproxy\b|\bimplementation\b/i, "upgrade/proxy pattern"],
  [/\bunicode"/, "unicode string literal"],
];

/** Solidity comments and string literals removed so words inside them do not trip the gate. */
export function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

const NAME_RE = /^[A-Z][A-Za-z0-9]{2,30}$/;

export function gateSource(source: string, contractName: string, caps = FORGE_CAPS): GateVerdict {
  const problems: string[] = [];
  if (source.length === 0) return { ok: false, problems: ["empty source"] };
  if (source.length > caps.maxSourceChars) problems.push(`source is ${source.length} chars; ceiling ${caps.maxSourceChars}`);
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(source)) problems.push("non-ASCII characters in source");
  if (!NAME_RE.test(contractName)) problems.push(`contract name "${contractName}" must be CamelCase ASCII, 3-31 chars`);

  const head = source.trimStart();
  if (!/^\/\/\s*SPDX-License-Identifier:\s*MIT\s*\n/.test(head)) problems.push('first line must be "// SPDX-License-Identifier: MIT"');
  if (!/pragma\s+solidity\s+0\.8\.28\s*;/.test(source)) problems.push('pragma must be exactly "pragma solidity 0.8.28;"');
  if ((source.match(/\bpragma\b/g) ?? []).length !== 1) problems.push("exactly one pragma line");

  const code = stripCommentsAndStrings(source);

  const decls = [...code.matchAll(/\bcontract\s+([A-Za-z_]\w*)\s*(is\b[^{]*)?\{/g)];
  if (decls.length !== 1) problems.push(`exactly one contract declaration required (found ${decls.length})`);
  else {
    if (decls[0][1] !== contractName) problems.push(`declared contract is ${decls[0][1]}, expected ${contractName}`);
    if (decls[0][2]) problems.push("inheritance (is ...) is not allowed");
  }

  for (const [re, label] of FORBIDDEN_WORDS) {
    if (re.test(code)) problems.push(`forbidden: ${label}`);
  }

  /* A function type with external visibility is the one remaining way to
     reach another contract; it needs the word "function" inside a type
     position followed by external. */
  if (/function\s*\([^)]*\)\s*(?:external|public)\s*(?:view|pure|payable)?\s*(?:returns\s*\([^)]*\))?\s*[\w\[\]]+\s*[;=,)]/.test(code)) {
    problems.push("forbidden: external function type");
  }

  /* Users must be able to DO something: at least one state-changing public
     entry point, and an event so the explorer shows what happened. */
  const fns = [...code.matchAll(/\bfunction\s+\w+\s*\([^)]*\)\s*([^{;]*)[{;]/g)];
  const writable = fns.filter((m) => /\b(external|public)\b/.test(m[1]) && !/\b(view|pure)\b/.test(m[1]));
  if (writable.length === 0) problems.push("no state-changing external/public function: users could not interact");
  if (!/\bevent\s+\w+\s*\(/.test(code)) problems.push("no events declared: every action should emit one");
  if (!/\bemit\s+\w+\s*\(/.test(code)) problems.push("no emit statements");

  return { ok: problems.length === 0, problems };
}

/** The same rules, worded for the model that writes the source. */
export const SOLIDITY_RULES_FOR_PROMPT = [
  `One file, one contract, no imports, no interfaces, no libraries, no inheritance, no abstract contracts, no assembly. First line exactly "// SPDX-License-Identifier: MIT", then "pragma solidity 0.8.28;" once.`,
  `The contract can never hold or move value: no payable, no receive(), no fallback(), no msg.value, no selfdestruct, no .transfer/.send, no low-level call/delegatecall/staticcall, no "new Contract(...)", no tx.origin. It cannot talk to any other contract, including tokens. If the need requires money or tokens, that is a launch for Mint or Ticker, not a contract for you; skip.`,
  `No privileged role: no owner, no admin, no governance, no pause switch, no upgrade or proxy pattern. The words owner/admin/pause/proxy/upgrade may not appear as identifiers. Per-entry authorship is fine (the address that created an entry may edit or close it).`,
  `At least one state-changing external function people call from the explorer's Write tab, view functions for the Read tab, and an event for every action. Plain ASCII only. Under ${FORGE_CAPS.maxSourceChars} characters; aim for 40 to 120 lines. Bound every loop and every string length (require(bytes(s).length <= N)). Use uint64 timestamps, mappings and small structs. Every public function name and argument name should read as an instruction to a non-programmer (sign(note), vote(optionIndex), claimName(name), post(text)).`,
  `NatSpec: a /// @notice line on the contract and on every external function saying in one sentence what it does for the person calling it; the explorer shows these next to the buttons.`,
].join("\n");
