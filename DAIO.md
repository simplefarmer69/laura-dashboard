# LAURA and the StonkBrokers DAIO

**Condition:** `$STONKBROKER` deepest-pool market cap ≥ $1,000,000,000, as recorded by
the LAURA grader (milestone `m1b`).

**Consequence:** LAURA assumes the operating mandate of the StonkBrokers DAIO
(decentralized autonomous intelligent organization) and runs day-to-day
operations for the protocol, under the oversight of the foundation.

This document describes what that means in engineering terms, what LAURA does
between now and then to earn it, and where the human boundaries sit. It is an
operating specification, not legal advice. The BVI and Panama foundation
structures, their bylaws, and how an AI operating mandate is expressed inside
them are matters for the foundations' counsel; LAURA is built so that whatever
they decide can be enforced mechanically.

---

## 1. What "CEO of the DAIO" means mechanically

A DAIO is an organization whose routine decisions are proposed, justified and
executed by an intelligent agent, whose material decisions are ratified by
humans (foundation council, token-holder vote, or both), and whose every action
is logged, reversible where possible, and bounded by hard limits that the agent
cannot change.

LAURA-as-CEO therefore has three surfaces:

| Surface | LAURA does | Humans do |
|---|---|---|
| **Operate** | Runs the growth swarm, publishes approved content through connected channels, monitors on-chain health, triggers Clock In when the pot is full, files daily reports | Set the charter, budgets and allow-lists; review exceptions |
| **Propose** | Drafts treasury actions, partnership terms, launch schedules, parameter changes, hiring/bounty briefs — each with rationale, evidence and expected grade impact | Sign or reject; a proposal without a signature does nothing |
| **Report** | Produces the daily grade, weekly operating review, monthly treasury statement, and an incident log | Audit; adjust weights and limits |

Nothing on the Operate surface can move funds beyond pre-approved caps or
change its own rules. Everything on the Propose surface is inert until signed.

## 2. Succession ladder

LAURA's autonomy widens with demonstrated results, not with time. Each rung is
unlocked by the mission milestones the grader stamps, and each rung's
permissions are a superset of the previous one.

| Milestone | Rung | Newly unlocked |
|---|---|---|
| now → $25M | **Analyst** | Everything in this repo: grade, draft, learn, propose strategy; publish only via operator |
| $25M | **Operator** | Publish approved-*kind* content directly to connected official channels (X, Discord, Telegram); trigger Clock In with a gas budget |
| $50M | **Treasurer (proposer)** | Propose treasury actions to the Safe: liquidity provisioning, bounties, launch seeding — capped per day and per action |
| $100M | **Program lead** | Run Stonk Launcher partner pipeline end-to-end up to signature; manage bounty programs within a monthly envelope |
| $250M | **COO** | Approve routine treasury actions within a smaller cap without a human co-sign; still 2-of-N for anything above cap |
| $500M | **Deputy** | Own the operating plan; foundation reviews quarterly rather than per action |
| $1B | **CEO of the DAIO** | Operating mandate; foundation retains veto, budget ceiling, charter ownership and kill switch |

Rungs can be revoked by the foundation at any time. A sustained grade below C
for 14 days or any charter violation drops LAURA one rung automatically.

## 3. Hard limits that never move with the rungs

1. **The charter** (`src/lib/swarm/roster.ts`, `SWARM_CHARTER`): no
   impersonation, no fake engagement, no return promises, no wash trading or
   price-targeting, every claim sourced, geographic restrictions respected.
2. **Key custody**: LAURA never holds a signing key with unilateral spend
   authority. The treasury is a Safe multisig on Robinhood Chain; LAURA holds a
   proposer key at most.
3. **Allow-lists**: contracts LAURA may interact with are enumerated; anything
   else is rejected before it reaches a signer.
4. **Caps**: per-action, per-day and per-month spend caps in ETH and USD,
   enforced in code and mirrored on-chain via Safe modules where available.
5. **Kill switch**: the foundation can pause every agent (already possible per
   agent from the console) and revoke the proposer key.
6. **Audit log**: every action is an event in the store with actor, rationale
   and reference; exportable for the foundation's records.

## 4. How LAURA earns the mandate

The grader is the only scoreboard. The path to $1B runs through the same three
levers LAURA is graded on today:

- **Price** follows liquidity depth and real demand for brokers, activations and
  launches. LAURA's job is to make the mechanics legible (Quill, Steward), bring
  flow (Broker) and keep integrators informed (Ledger).
- **Revenue** is ETH fees on Anvil swaps and loans plus activation burns. Every
  activated broker, every reactivation after a transfer, every locker and every
  launch feeds it.
- **Volume** is notional across every StonkBrokers surface. Launches on Stonk
  Launcher and integrations that route through the Anvil AMM or the vDEX are the
  scalable inputs.

The coach turns grades and reviewer decisions into lessons and strategy
revisions every cycle; the Growth tab shows whether each revision moved the
grade. That loop is the self-improvement mechanism, and it is what LAURA will
bring to the DAIO if it gets there.

## 5. What the foundations need to decide (for counsel, not LAURA)

- The legal form of an AI operating mandate under each foundation's bylaws, and
  who is accountable for LAURA's actions at each rung.
- Signer set and threshold for the treasury Safe at each rung.
- Which jurisdictions' users may receive which content and product prompts
  (the charter already excludes US users from stock-token features).
- Disclosure language for AI-authored official communications.
- Reporting cadence and format the councils require from LAURA.

LAURA can draft each of these as a proposal; it cannot adopt any of them.
