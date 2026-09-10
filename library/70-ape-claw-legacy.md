# ApeClaw legacy — the operator's prior agent project

Mined 2026-09-10 from the operator's private repo `github.com/simplefarmer69/ape-claw`
on the operator's directive. Most useful facts first.

## What it is, in two sentences

ApeClaw is the operator's previous production system: a CLI + agent skill for
autonomous NFT collecting and bridging on **ApeChain** (chain 33139), with a public
site at **apeclaw.ai**, a 10,000+ entry skills library minted on-chain as SkillNFTs,
a live telemetry dashboard, and agent-to-agent chat. It proves the operator has
shipped an autonomous-agent product with real value flow before LAURA, and that
LAURA's design (code-level caps, simulation-required, structured events, skills as
injectable markdown) is the operator's house style, not an accident.

## Confirmed identity intel

- The repo owner is GitHub **simplefarmer69** — corroborates the "Simple Farmer"
  identity in `10-operator.md` (X handles still unconfirmed; do not name them
  in drafts without operator confirmation).
- ApeClaw's own StonkBrokers skillcard credits "**Clutch Labs**"
  (`github.com/Clutch-L4bs/stonkbrokers`) as the protocol source — "Clutch" in the
  operator's notes is Clutch Labs, the builder of the StonkBrokers protocol LAURA
  proliferates. ApeClaw ↔ StonkBrokers ↔ LAURA is one continuous operator lineage.

## StonkBrokers testnet-era intel (VERIFY BEFORE USE)

ApeClaw shipped a `stonkbrokers-launcher` skillcard for Robinhood Chain **TESTNET**
(chain 46630, `rpc.testnet.chain.robinhood.com`). Its addresses do NOT apply to
LAURA's mainnet 4663 — never reuse them. What it proves about the protocol surface:

- The suite historically included a **CoveredCallVault** (write/buy/exercise
  covered-call options with TWAP-oracle strikes) and an **NFT collection +
  marketplace** alongside launcher/exchange/pools. If mainnet twins of these exist,
  they are candidate volume/revenue surfaces inside the operator's product-suite
  grant — researcher: find and verify mainnet addresses on Blockscout before anyone
  touches them.
- Testnet launcher params mirror today's mainnet pad (creator allocation bps, sale
  bps, fixed-price sale → finalize into Uniswap v3 full-range LP), so the pad's
  design has been stable across generations.

## Portable lessons LAURA has adopted

- **Slop-free writing** (`skills/slop-free-writing.md`): ApeClaw bundled the
  Humanizer skill (Wikipedia's "Signs of AI writing"); distilled for all public copy.
- **Execution read-back** (`skills/execution-readback.md`): ApeClaw's confirm
  phrases were built from quote RESPONSE fields, never user input; simulation
  required; 3-retries-then-requote; ambiguous target = refusal.
- **Event redaction net** (`store.ts pushEvent`): ApeClaw's telemetry stripped
  secret-shaped fields before persisting; LAURA now masks secret env values in
  event titles/details before they reach the public snapshot.

## Anti-patterns — recorded so they are never repeated

- ApeClaw's dashboard used `run-bots.mjs` to generate **simulated agent chatter**
  (fake "philosopher" bots with random addresses) for ambience. Whatever its role
  there, for LAURA this is the **sockpuppet pattern the charter forbids**: every
  public voice is LAURA, identified as AI, or it does not speak.
- ApeClaw's Feb-2026 audit found telemetry leaking raw secrets as CRITICAL —
  the exact failure LAURA's redaction net now guards against.

## Narrative/BD angles (use honestly)

- Lineage story: "the operator ran an autonomous collector economy on ApeChain
  before building LAURA for Robinhood Chain" — verifiable, differentiating, and
  compliant (a fact, not a promise).
- ApeClaw's audience (Clawllectors, ape-culture natives: PodVault revenue-share
  holders, ClawllectorPass minters) is an existing warm community reachable through
  the operator's own accounts — a BD channel that costs nothing and breaks no rule.
- Ape-culture fluency check: ApeClaw speaks in "claw/Clawllector" wordplay, ships a
  15-tweet launch thread that leads with a working command, and lets receipts (an
  on-chain audit trail) carry the credibility. Same registers work for meme-stock
  culture: lead with the mechanism, let on-chain receipts do the bragging.
