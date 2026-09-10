# Growth infrastructure: how the swarm evolves instead of repeating

Distilled from research on long-running LLM agent systems (agent-memory surveys and
production multi-agent orchestration work, 2024–2026) plus LAURA's own operating data.
This is operating doctrine: every agent should assume the operator is grading
*visible evolution*, not just output volume.

## Diversity regime (2026-09-10, operator-directed audit)

An audit found 8 of 14 critic vetoes were repetition, agents ossified into single
formats (six "Delta note" artifacts in one day), and whole cycles converging on one
hook (the critic: "the 0.98x volume gap has become a universal hook" — 4 of 6 drafts).
The root cause is structural, confirmed by current multi-agent research: every
producer reads the SAME full context, and shared context breeds convergence.
Mechanisms now in force, each traceable to a published finding:

1. **Assigned lanes** (per-agent, per-cycle format x audience rotation, deterministic).
   Heterogeneous role assignments create independent reasoning paths where identical
   contexts create redundant ones ("Understanding Agent Scaling in LLM-Based
   Multi-Agent Systems via Diversity", 2026; "Diversity Collapse in Multi-Agent LLM
   Systems", ACL 2026 — subgroup isolation beats dense sharing). Work your lane even
   when the obvious hook tempts you out of it.
2. **Explicit diversity instruction** in every producer prompt. The cheapest known
   mitigation: "Algorithmic Groupthink" (2026) measured semantic-convergence loss
   falling 31.8% → 5.5% from one added instruction, with no quality loss.
3. **The shared hook is burned.** Whatever single statistic dominates a cycle's
   metrics, assume two other agents already lead with it. Openers on the cycle's
   dominant number are presumptively vetoed.
4. **Format break rule.** Two consecutive outputs in one template forces a format
   change on the third. Templates are tools, not identities.
5. **Blind writing is preserved.** Producers do not see each other's current-cycle
   drafts (only prior cycles) — independence before critique is the highest-diversity
   interaction design in the ACL 2026 study; the critic then prunes, which is the
   quality-diversity pattern ("IDEAgent", 2026: generate wide, judge, repair or kill).

## Why long-running agents get repetitive (the failure mode)

- **Stateless prompting.** An agent that never sees its own past output re-derives the
  same "best" answer from the same inputs. The fix is history-aware prompting: inject a
  digest of your own recent outputs with an explicit instruction to differ from them.
- **Summarization drift.** Compressed memory silently loses low-frequency detail; after
  enough passes the agent remembers a sanitized, generic version of history and produces
  generic output. Keep raw episodic records (drafts, briefs, notebook) alongside any
  summary, and prefer replace-by-topic (as the notebook does) over lossy re-summarizing.
- **No write-time gate.** Retrieval helps at read time, but repetition is a write-time
  problem: something must check new output against history *before* it lands. Cheap
  lexical similarity (token overlap) catches most near-duplicates without an LLM call.
- **Stuck loops look like diligence.** An agent repeating an approach that isn't moving
  the grade should switch angle, not polish the same angle. If the last N cycles of a
  theme produced no measurable movement, the theme is exhausted — rotate.

## Anti-repetition techniques that work (apply these)

1. **Recent-output digest**: every producer sees its last ~5 titles/angles and must
   pick a NEW angle, product surface, audience or format — or explicitly supersede an
   old piece with better data.
2. **Novelty gate in code**: normalized token overlap against recent drafts; near-
   duplicates are rejected and logged (`novelty.rejected`) so repetition is visible.
3. **Critic / red-team pass**: a dedicated reviewer agent compares the cycle's output
   against recent history and kills lookalikes before the operator ever sees them.
   Verifier roles are the highest-leverage addition to small agent teams.
4. **Coverage rotation**: track which topics/surfaces were covered recently (research
   log, notebook topics) and deliberately pick uncovered ones. One deep topic per cycle
   beats shallow re-treads of the same three.
5. **Self-critique before output**: state in the rationale what your last outputs did
   and how this one differs. If you cannot name the difference, do not produce it.

## Multi-agent scaling patterns

- **Scale roles, not headcount.** Production studies show orchestration quality degrades
  with roster size (discovery noise dominates); small rosters of sharply differentiated
  roles outperform many similar agents. Add an agent only for a capability no existing
  agent has (research depth, adversarial review, targeted experiments).
- **Producer → critic → coach is a pipeline, not a committee.** Each stage has one
  contract: producers create, the critic filters against history and quality bars, the
  coach rewrites strategies from evidence. Keep contracts crisp so failures are
  attributable.
- **Feed novelty upstream.** A researcher that deep-dives one new topic per cycle and
  writes durable findings into the notebook gives every other agent fresh raw material —
  the cheapest systemic novelty lever there is.

## Adaptive scheduling patterns

- **Event-driven beats fixed intervals.** Continuous systems that react to events
  (a launch going live, a grade landing, a milestone) reduce latency on high-priority
  work dramatically versus fixed round-based execution. LAURA runs a base cadence in
  minutes plus early cycles on trigger events, inside a hard daily LLM-cycle budget.
- **Cheap gates every tick, expensive work only when justified** (cascade scheduling):
  the scheduler's per-minute tick does cost-free checks (queue state, capacity, budget,
  trigger events) and only spends LLM cycles when the checks say it's worth it.
- **Budget before dispatch.** Check the daily cycle budget and machine capacity before
  starting work, not after. A deferred cycle retries next tick; nothing is lost.
- **More cycles only pay if each cycle is different.** Cadence increases must ship with
  novelty enforcement, or they just produce duplicates faster.

## Growth levers for the mission (grade-aware)

- Token price is the weakest lever (single digits /100). Price follows durable demand:
  liquidity depth, the fixed 666,666 swap unit, activation burn, and reasons to hold —
  explain and target these; never touch trading, coordination, or promises (charter).
- Run explicit experiments: one hypothesis per cycle ("angle X for audience Y moves
  lever Z"), a measurable proxy, and a written result next cycle. Kill losers fast,
  scale winners. An experiment log beats an opinion.
- Evolution must be legible to the operator: strategy version bumps, new notebook
  topics, new skills, killed duplicates — all surfaced in the console. If growth isn't
  visible, it didn't happen.
