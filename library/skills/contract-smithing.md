---
name: contract-smithing
description: Use when designing, repairing or announcing one of Anvil's small standalone contracts — picking a real need from X, writing gate-clean Solidity 0.8.28, fixing compiler errors from their exact message, and explaining the Write tab to a stranger
agents: smith, critic, quill
---

# Contract smithing

Anvil ships small contracts people asked for. The bar is not cleverness; it is
a stranger pressing one button on the explorer and getting what they wanted.

## Pick the need, or skip

- Quote the ask with its handle and tweet id from WATCHED VOICES, LAUNCH
  REQUESTS or the X pulse. If nobody asked, skip with a reason. Skipping most
  strides is the expected outcome.
- One contract, one job, one screen of source. Guestbook, poll, RSVP or pledge
  registry, name registry, commit-reveal game with no money, time capsule,
  who-was-first counter for a launch. If the idea needs money, tokens or
  another contract, it is a launch (Mint/Ticker) or an operator-reviewed
  flagship, not yours.

## Write inside the gate

The gate reads the source before the compiler; anything below is a hard
reject, not a warning: `import`, `interface`, `library`, `abstract`,
`is` (inheritance), `payable`, `msg.value`, `receive`, `fallback`, `.call`,
`.transfer`, `.send`, `delegatecall`, `staticcall`, `selfdestruct`,
`assembly`, `new`, `owner`, `admin`, `governance`, `pause`, `upgrade`,
`proxy`, `tx.origin`, `create2`, `unicode"` literals, external function
types, non-ASCII characters, more than one contract, source over 7,000 chars.
Comments and string literals are stripped first, so words inside them are fine.

Pattern that passes: `// SPDX-License-Identifier: MIT`, `pragma solidity
0.8.28;`, one `contract CamelCase`, custom errors, `mapping`s and bounded
arrays, `string calldata` inputs capped with `bytes(s).length <= N`, an event
on every state change, no loops over unbounded storage, view functions for
everything a frontend would show. Constructor arguments are strings in the
design, ABI order, only `uint*`, `int*`, `bool`, `address`, `string`,
`bytes32`-style fixed bytes.

## Repair from the message

A compile or gate failure comes back once or twice with the exact message.
Change what the message names and nothing else; do not redesign. If the gate
names a forbidden word, rename the identifier (for example `author` instead
of `owner`, `creator` instead of `admin`).

## howToUse is for a stranger

Name the function on the Write tab, the inputs in order with an example
value, and what happens (which event fires, what the Read tab shows after).
One paragraph. No wallet tutorials.

## Announce only when verified

The X post goes out after Blockscout or Sourcify accepts the source. Two or
three plain sentences: what it is and who it is for, how to use it in one
clause, the explorer link. No hashtags, no emoji, no price talk. Flagship
posts add that anyone can host a frontend and link the guide.
