# Mint agent (token launches) - operator reference

Mint is the swarm agent that designs and ships token launches on the Smart
Launch V2 pads. Launches are LAURA's public voice: every deploy appears in the
community Telegram, and every trade pays her creator fees. This document is the
operator reference for the launch tempo controls; the agent-facing playbook
lives in `library/skills/launch-design.md` and `library/50-playbook.md`.

## How a launch flows

1. **Design.** Mint's orchestrator step runs every LLM cycle, gated by the
   speech gate (`mintGate` in `src/lib/swarm/tuner.ts`). When clear, the LLM
   designs at most ONE spec per cycle against the live lane menu, floor
   digest and launch capacity block.
2. **Approve.** Specs enter the queue already approved when
   `autoExecuteLaunches` or `autoApproveProposals` is on (both default on);
   the autonomy sweep also promotes anything left pending.
3. **Deploy.** The launch executor (`src/lib/launchpad/executor.ts`) runs on
   every scheduler tick and deploys at most ONE approved spec per tick
   (burst safety), then arms supply and verifies floor visibility on later
   ticks. Weekend-closed stock lanes stay queued until Monday.

## Mint freedom (2026-09-10)

The `mintFreedom` setting (Settings tab on the dashboard, or PATCH
`/api/settings`) picks the speech-gate pace. It defaults ON.

| Limit | Freedom ON (default) | Freedom OFF (kill switch) |
| --- | --- | --- |
| Cooldown after a deploy | 2h | 12h |
| Open specs (pending + approved) | 4 | 2 |

Flipping it off is the one-toggle way to return Mint to the legacy
~2 launches/day pace. Approval autonomy is unchanged either way.

## Tunable knobs

Settings (live, no restart):

- `mintFreedom` (boolean, default true) - the pace switch above.

Hard caps (NOT tunable; the operator's standing safety config, restored
2026-09-10 after an unauthorized default raise):

- `LAUNCH_CAPS.maxDeploysPerDay` = 3 per rolling 24h across all lanes
  combined, and `LAUNCH_CAPS.maxSpendEthPerDeploy` = 0.02 ETH. Hard constants
  in `src/lib/launchpad/service.ts`; raising them requires an explicit
  operator-authorized code change, never an env var.

Env vars on the VM (restart applies; all clamped in code):

- `MINT_COOLDOWN_HOURS` - overrides the speech-gate cooldown for the current
  pace. Clamped 0..48. Checked on every gate call (no restart needed if the
  process rereads env, but treat it as restart-applied to be safe).
- `MINT_QUEUE_LIMIT` - overrides the open-spec ceiling. Clamped 1..12.

## Safety floors that never bend

These are correctness gates, deliberately untouched by mint freedom:

- **Per-deploy spend cap** (`LAUNCH_CAPS.maxSpendEthPerDeploy`, 0.02 ETH) -
  re-checked fail-closed inside `deployLaunch` after gas estimation.
- **Daily deploy ceiling** (`LAUNCH_CAPS.maxDeploysPerDay`, 3/24h) - enforced
  in the executor before every deploy, counted over the rolling 24h.
- **Funded wallet floor** - the executor holds the whole queue while the
  designated swarm wallet sits at or below 0.002 ETH.
- **Live pad-bounds revalidation** - every spec is re-checked against the
  pad's on-chain bounds at deploy time.
- **Weekend stock-lane gate** (`src/lib/launchpad/lanes.ts`) - stock lanes
  (gme, nvda, aapl, spcx, uso) close Friday 20:00 UTC to Monday 00:15 UTC
  because their Chainlink feeds pause. Weekend specs remap to crypto lanes at
  design time; anything already queued on a closed lane simply waits.
- **Duplicate dedupe** (`isDuplicateLaunch` in `src/lib/launchpad/spec.ts`) -
  a name or symbol matching any non-rejected launch is dropped.
- **One deploy per scheduler tick** plus 15 min failure backoff - a bad spec
  can never drain the wallet in a burst.

## Throttling back

- Fastest: flip **Mint freedom** off in Settings (12h cooldown, 2-spec queue).
- Finer: set `MINT_COOLDOWN_HOURS` / `MINT_QUEUE_LIMIT` on the VM.
- Emergency: pause the Mint agent from the dashboard roster, or turn off
  `autoExecuteLaunches`.

## VM rollout

1. `git pull` on the VM checkout and restart the swarm process (`npm run
   build` + restart, or however the service is supervised). The new settings
   key backfills into existing `state.json` automatically with freedom ON.
2. No env changes are required for the defaults (3/day hard cap, freedom
   pace). Set the gate env knobs above only to deviate.
