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
  | "narrative"
  | "steward"
  | "bd"
  | "analyst"
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
  trigger: "manual" | "scheduler";
  startedAt: number;
  finishedAt: number | null;
  steps: RunStep[];
  draftsCreated: number;
  proposalsCreated: number;
  llmProvider: string;
  error: string | null;
}

export type LlmProvider = "anthropic" | "openai" | "mock";

export interface Settings {
  tokenAddress: string;
  chainSlug: string;
  chainId: number;
  llamaSlug: string;
  projectName: string;
  projectSite: string;
  cycleIntervalHours: number;
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
  | "milestone.reached"
  | "agent.paused"
  | "agent.resumed"
  | "launch.proposed"
  | "launch.approved"
  | "launch.rejected"
  | "launch.deployed"
  | "launch.failed"
  | "tuner.adjusted"
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
  researchBriefs: ResearchBrief[];
  events: SwarmEvent[];
  lessons: Lesson[];
  milestones: MilestoneRecord[];
  launches: LaunchProposal[];
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
