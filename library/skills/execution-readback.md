---
name: execution-readback
description: Use when proposing or reviewing any on-chain execution (treasury buys, Smart LP, deploys) — parameters come from authoritative read-backs, never from your own draft
agents: vault, mint, critic
---

# Execution read-back

Distilled from the operator's prior project (ape-claw), whose CLI moved real
value on ApeChain behind eight code-level safety gates without an incident.
The gates that live in prompts rather than code are these; LAURA's code-level
caps (treasury-caps.ts, LAUNCH_CAPS) stay absolute on top of them.

## The read-back rule

Every number in an execution proposal must come from an authoritative on-chain
or API read-back — a quote, a simulation result, `getLaunch(id)`, the floor
API, `buyEligibility` — never from your own earlier prose. ape-claw enforced
this by building its confirm phrase from the QUOTE RESPONSE fields, not the
user's input; the same discipline here means: after drafting, re-derive
amount, token address, pool, and tier from the live reads in your prompt and
state the source next to each. A number you cannot source is a number you
must not execute.

## Gates

1. **Simulation immediately before send.** A simulation that passed earlier in
   the cycle is stale once price, balance, or caps moved. LAURA's code already
   simulates at send time; never propose a path that skips or pre-dates it.
2. **Bounded retry, then re-quote.** Transient failure (RPC blip, nonce):
   retry a few times with backoff. Changed world (price moved past slippage,
   listing gone, quote expired): do NOT force the old plan — go back to the
   quote step and re-derive from scratch. ape-claw's pattern: 3 retries, then
   re-fetch fresh listings.
3. **Ambiguity is a stop.** Multiple pools, tokens, or addresses matching a
   name means halt and name the ambiguity in your output. ape-claw refused
   buys when a collection resolved to more than one match; LAURA refuses the
   same way. Never pick "probably the right one" for anything that signs.
4. **Preflight before proposing.** Check readiness the way ape-claw's `doctor`
   did, and read every issue: caps headroom (`buyEligibility` reason strings,
   LAUNCH CAPACITY), treasury floor (0.35 ETH never breached), allowance,
   cooldowns. If not ready, the correct output is the missing prerequisite
   and when it clears — not the order.
5. **Dry-run mentality.** A proposal without stated simulation/quote evidence
   is a draft, not an order. Write executions so the critic can verify every
   figure against the same reads you used.

## Inviolables (code, not judgment)

Only $STONKBROKER (0xe934e36a439c94017b64a3fece66af12099abf50) is ever bought;
never LAURA's own launched tokens. Max 0.005 ETH/buy, 0.01 ETH/24h, 6h gap,
0.35 ETH floor; LP total 0.02 ETH-equiv. 3 deploys/24h, 0.02 ETH/deploy.
Every position states its mission rationale as an event.
