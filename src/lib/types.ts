export type MetricSource = "live" | "partial" | "mock";

export interface MetricsSnapshot {
  ts: number;
  /** DexScreener: aggregated across all STONKBROKER pairs on Robinhood Chain */
  priceUsd: number;
  priceChange24hPct: number;
  tokenDexVolume24hUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  pairCount: number;
  /** DefiLlama: protocol-wide dimensions */
  protocolFees24hUsd: number;
  protocolRevenue24hUsd: number;
  protocolVolume24hUsd: number;
  protocolFees7dUsd: number;
  protocolRevenue7dUsd: number;
  protocolVolume7dUsd: number;
  tvlUsd: number;
  /** Direct reads from Robinhood Chain RPC; absent when the RPC was unreachable */
  onchain?: OnchainReads;
  source: MetricSource;
  warnings: string[];
}

export interface OnchainReads {
  blockNumber: number;
  ethPriceUsd: number;
  /** ETH sitting in Clock In v2 waiting to be swapped into stock tokens */
  clockInPotEth: number;
  clockInPotUsd: number;
  /** Broker NFTs held by the Anvil AMM vault (4444 minus this = in holders' hands) */
  brokersInVault: number;
  brokersInCirculation: number;
  /** Current $STONKBROKER total supply; falls as activation fees burn */
  tokenTotalSupply: number;
}

/** One tweet worth remembering from the live X reads (clipped for storage). */
export interface IntelTweet {
  id: string;
  /** Username when known (leader timelines), otherwise the numeric author id. */
  author: string;
  createdAt: string;
  text: string;
  likes: number;
  retweets: number;
  replies: number;
  impressions: number;
}

/** X read-API intelligence gathered with the app-only bearer (read endpoints only). */
export interface XIntel {
  fetchedAt: number;
  /** Tweets matching the $STONKBROKER search in the last 24h (recent-search window). */
  mentionCount24h: number;
  /** Sum of likes+retweets+replies across those mentions. */
  engagement24h: number;
  /** Top mentions by engagement, clipped. */
  topMentions: IntelTweet[];
  /** Latest original tweets from Robinhood leadership (vladtenev, JohannKerbrat). */
  leaders: { username: string; tweets: IntelTweet[] }[];
  /** Which X endpoints answered vs were rate-limited/blocked this cycle. */
  note: string;
}

/**
 * Per-cycle snapshot of live internet context beyond the market metrics:
 * X mentions/engagement (influence), Robinhood leadership activity, ETH
 * macro context, and Blockscout holder/transfer counts when reachable.
 * Every field is optional-by-null — fetchers are non-fatal by design.
 */
export interface IntelSnapshot {
  ts: number;
  x: XIntel | null;
  ethUsd: number | null;
  ethUsd24hChangePct: number | null;
  /** $STONKBROKER holder count from Blockscout; null when the API is unreachable. */
  holderCount: number | null;
  /** Lifetime $STONKBROKER transfer count from Blockscout; null when unreachable. */
  tokenTransferCount: number | null;
  /** Endpoints that returned real data this cycle. */
  sources: string[];
  warnings: string[];
}

export interface GradeComponent {
  key: "price" | "revenue" | "volume" | "execution";
  label: string;
  weight: number;
  /** 0..100 */
  score: number;
  detail: string;
}

export type LetterGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface DailyGrade {
  id: string;
  /** YYYY-MM-DD in UTC */
  date: string;
  ts: number;
  score: number;
  letter: LetterGrade;
  components: GradeComponent[];
  metrics: MetricsSnapshot;
  baseline: MetricsSnapshot | null;
  summary: string;
}

export type AgentId =
  | "scout"
  | "researcher"
  | "narrative"
  | "steward"
  | "bd"
  | "analyst"
  | "growth"
  | "critic"
  | "mint"
  | "coach";

export type AgentStatus = "idle" | "running" | "error" | "paused";

export interface AgentStrategyVersion {
  version: number;
  strategy: string;
  adoptedAt: number;
  reason: string;
  /** Swarm grade when this version went live, for before/after comparison */
  gradeAtAdoption: number | null;
  /** Swarm grade when this version was retired */
  gradeAtRetirement: number | null;
}

export interface Agent {
  id: AgentId;
  name: string;
  role: string;
  objective: string;
  /** Live, editable operating instructions. Versioned via proposals. */
  strategy: string;
  strategyVersion: number;
  versionAdoptedAt: number | null;
  gradeAtVersionAdoption: number | null;
  history: AgentStrategyVersion[];
  status: AgentStatus;
  lastRunAt: number | null;
  lastError: string | null;
  stats: {
    runs: number;
    drafts: number;
    approved: number;
    rejected: number;
    published: number;
  };
}

export type DraftKind =
  | "thread"
  | "article"
  | "community"
  | "outreach"
  | "report"
  | "video-script"
  | "research";

export type DraftStatus = "pending" | "approved" | "rejected" | "published";

export interface Draft {
  id: string;
  cycleId: string;
  agentId: AgentId;
  kind: DraftKind;
  channel: string;
  title: string;
  body: string;
  rationale: string;
  status: DraftStatus;
  createdAt: number;
  reviewedAt: number | null;
  reviewerNote: string | null;
  /** Set when the draft was published through a connected channel (e.g. X). */
  publishedUrl?: string | null;
}

export type ProposalStatus = "pending" | "approved" | "rejected";

export interface StrategyProposal {
  id: string;
  cycleId: string;
  agentId: AgentId;
  fromVersion: number;
  currentStrategy: string;
  proposedStrategy: string;
  rationale: string;
  evidence: string[];
  status: ProposalStatus;
  createdAt: number;
  reviewedAt: number | null;
  autoApplied: boolean;
}

export type RunStepStatus = "ok" | "error" | "skipped";

export interface RunStep {
  agentId: AgentId | "grader" | "system";
  label: string;
  status: RunStepStatus;
  summary: string;
  durationMs: number;
}

export interface CycleRun {
  id: string;
  /** "event" = an early cycle fired by a trigger event (launch live, milestone). */
  trigger: "manual" | "scheduler" | "event";
  startedAt: number;
  finishedAt: number | null;
  steps: RunStep[];
  draftsCreated: number;
  proposalsCreated: number;
  llmProvider: string;
  error: string | null;
  /** LLM telemetry; absent on runs recorded before telemetry existed. */
  llmCalls?: number;
  /** Calls that fell back to the deterministic mock after the LLM failed. */
  llmFallbacks?: number;
  /** Calls that needed the schema-repair retry to produce valid output. */
  llmRepairs?: number;
}

export type LlmProvider = "anthropic" | "openai" | "mock";

export interface Settings {
  tokenAddress: string;
  chainSlug: string;
  chainId: number;
  llamaSlug: string;
  projectName: string;
  projectSite: string;
  /** Base LLM-cycle cadence. Event triggers can run a cycle early; the daily budget bounds cost. */
  cycleIntervalMinutes: number;
  /** Hard code-level cap on LLM cycles per rolling 24h (scheduled + event; manual cycles count but are never blocked). */
  maxLlmCyclesPerDay: number;
  /** When true the coach's strategy-text proposals apply without review. Publishing is always gated. */
  autoApplyStrategyProposals: boolean;
  maxDraftsPerCycle: number;
  llmModel: string;
  /** Daily data-driven adjustment of cadence and draft budget inside hard rails. */
  autoTune: boolean;
  /**
   * Operator-granted launch autonomy: Mint's specs auto-approve and deploy
   * without per-launch review. Hard caps (deploys/day, spend/deploy, live
   * pad bounds, funded designated wallet) still apply and fail closed.
   */
  autoExecuteLaunches: boolean;
  /**
   * Full proposal autonomy: drafts, strategy proposals and launch specs
   * auto-approve on creation, and anything left pending is swept to approved
   * on the next scheduler tick. External publishing and the launch hard caps
   * (deploys/day, spend/deploy, pad bounds) remain gated.
   */
  autoApproveProposals: boolean;
  /**
   * Autonomous claiming of creator-fee fallback ledgers (flushCreatorQuote).
   * Creator fees are normally push-paid per trade; this only fires when a
   * push failed and value sits in creatorQuoteOwed. OFF by default while
   * on-chain transaction ownership sits with the launch executor work.
   */
  autoClaimEarnings: boolean;
  /**
   * Treasury operations: periodic capped $STONKBROKER accumulation buys with
   * treasury ETH (the wallet as a mission-influence tool). Hard code-level
   * caps in TREASURY_CAPS (per-buy, per-24h, buy gap, treasury floor) apply
   * regardless of this flag; the mission-token allowlist blocks every other
   * token, including LAURA's own launches (wash-trade guard).
   */
  autoTreasuryOps: boolean;
}

export type SwarmEventKind =
  | "cycle.started"
  | "cycle.finished"
  | "grade.stamped"
  | "brief.created"
  | "draft.created"
  | "draft.approved"
  | "draft.rejected"
  | "draft.published"
  | "proposal.created"
  | "proposal.adopted"
  | "proposal.rejected"
  | "strategy.edited"
  | "lesson.learned"
  | "note.recorded"
  | "novelty.rejected"
  | "critic.vetoed"
  | "milestone.reached"
  | "agent.paused"
  | "agent.resumed"
  | "launch.proposed"
  | "launch.approved"
  | "launch.rejected"
  | "launch.deployed"
  | "launch.armed"
  | "launch.verified"
  | "launch.failed"
  | "earnings.accrued"
  | "earnings.claimed"
  | "treasury.buy"
  | "tuner.adjusted"
  | "skill.updated"
  | "swarm.health"
  | "error";

export interface SwarmEvent {
  id: string;
  ts: number;
  kind: SwarmEventKind;
  agentId: AgentId | "grader" | "operator" | "system";
  title: string;
  detail: string;
  refId: string | null;
}

/** A durable insight the coach distilled; injected into every producer prompt as swarm memory. */
export interface Lesson {
  id: string;
  ts: number;
  cycleId: string;
  text: string;
  evidence: string;
}

export interface MilestoneRecord {
  id: string;
  label: string;
  marketCapUsd: number;
  reachedAt: number;
  priceUsd: number;
}

export type LaunchStatus =
  | "pending"
  | "approved"
  | "deploying"
  | "deployed"
  | "failed"
  | "rejected";

/** A token launch on the StonkBrokers Smart Launch V2 pad, designed by Mint. */
export interface LaunchProposal {
  id: string;
  cycleId: string;
  createdAt: number;
  /** Quote lane pad the launch deploys on */
  lane: "weth" | "stonk";
  name: string;
  symbol: string;
  /** Whole tokens; converted to wei at deploy */
  supplyTokens: number;
  startMcapUsd: number;
  gradMcapUsd: number;
  startTaxBps: number;
  taxDecayPerMinuteBps: number;
  postTaxBps: number;
  sellsEnabled: boolean;
  bufferSecs: number;
  concept: string;
  rationale: string;
  /**
   * The broadcast: what LAURA is saying to the humans watching new launches in
   * Telegram. Every launch is an act of speech; this is the intended message
   * (introduction, milestone, grade move, mission update). Optional for
   * launches created before speaking-via-tokens existed.
   */
  message?: string | null;
  /** Visual identity chosen by Mint; rendered procedurally into the token logo */
  artMotif?: string | null;
  artPalette?: string | null;
  status: LaunchStatus;
  reviewedAt: number | null;
  reviewerNote: string | null;
  /** Higher deploys first when autonomy executes the queue */
  priority?: number;
  /** Populated after deploy */
  txHash: string | null;
  tokenAddress: string | null;
  launchId: string | null;
  deployedAt: number | null;
  error: string | null;
  /** Launcher content hash once the logo is uploaded and attached */
  imageHash?: string | null;
  /** Set when the supply is loaded (`arm`) and the sale clock started; a deployed
   *  launch without this is registered but NOT live on the floor. */
  armedAt?: number | null;
  armTxHash?: string | null;
  /** Set when the token was confirmed visible on the Stonklauncher UI's own
   *  read surface (the /api/safe-launch/floor rows the /launcher page renders).
   *  An armed launch without this has NOT been proven user-visible. */
  verifiedAt?: number | null;
}

/** Creator-fee economics for one deployed launch (Smart Launch V2 pad). */
export interface LaunchEarnings {
  /** Local proposal id this entry tracks (state.launches[].id) */
  proposalId: string;
  /** On-chain launch id (per pad) */
  launchId: string;
  symbol: string;
  lane: "weth" | "stonk";
  /**
   * Lifetime creator-fee income from this launch's curve trades, in the
   * lane's quote token (WETH-lane units ≈ ETH). Push-paid to the wallet on
   * every taxed trade: tax × creatorFeeBpsSnap / 10000.
   */
  earnedQuote: number;
  /** Fallback ledger claimable via flushCreatorQuote (fills only when a push transfer failed) */
  claimableQuote: number;
  /** Curve trades seen (buys + sells) */
  tradeCount: number;
  graduated: boolean;
  bonded: boolean;
  /** Total flushed by our own claims */
  claimedQuote: number;
  lastClaimAt: number | null;
  /** Log-scan cursor: block the launch deployed at and last block scanned */
  deployBlock: number;
  scannedToBlock: number;
}

/** One executed mission-token accumulation buy (treasury ETH → $STONKBROKER). */
export interface TreasuryBuy {
  id: string;
  ts: number;
  /** Native ETH spent (the router wraps it); excludes gas */
  ethIn: number;
  /** $STONKBROKER received (wallet balance delta) */
  tokensOut: number;
  txHash: string;
  /** v3 fee tier the swap routed through (10000 = 1%, 3000 = 0.3%) */
  feeTier: number;
  router: string;
}

/** Periodic on-chain snapshot of LAURA's treasury and launch earnings. */
export interface TreasurySnapshot {
  updatedAt: number;
  walletAddress: string | null;
  ethBalance: number;
  /** WETH-lane creator fees land here; unwrap to spend as ETH */
  wethBalance: number;
  /** STONK-lane creator fees land here */
  stonkBalance: number;
  totalEarnedQuote: number;
  totalClaimableQuote: number;
  launches: LaunchEarnings[];
}

export interface SwarmState {
  version: 1;
  settings: Settings;
  agents: Agent[];
  drafts: Draft[];
  proposals: StrategyProposal[];
  runs: CycleRun[];
  grades: DailyGrade[];
  metricsHistory: MetricsSnapshot[];
  /** Live internet intel per cycle (X reads, ETH context, Blockscout). Absent before the intel layer existed. */
  intelHistory?: IntelSnapshot[];
  researchBriefs: ResearchBrief[];
  events: SwarmEvent[];
  lessons: Lesson[];
  milestones: MilestoneRecord[];
  launches: LaunchProposal[];
  /** Latest treasury/earnings snapshot; absent until the first refresh. */
  treasury?: TreasurySnapshot | null;
  /** Ledger of mission-token accumulation buys (caps are computed from this). */
  treasuryBuys?: TreasuryBuy[];
  /** UTC date the auto-tuner last ran (it runs at most once per day). */
  lastTuneDate: string | null;
}

export interface ResearchBrief {
  id: string;
  cycleId: string;
  createdAt: number;
  headline: string;
  bullets: string[];
  sources: string[];
}
