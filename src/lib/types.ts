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
  source: MetricSource;
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
  | "narrative"
  | "steward"
  | "bd"
  | "analyst"
  | "coach";

export type AgentStatus = "idle" | "running" | "error" | "paused";

export interface AgentStrategyVersion {
  version: number;
  strategy: string;
  adoptedAt: number;
  reason: string;
}

export interface Agent {
  id: AgentId;
  name: string;
  role: string;
  objective: string;
  /** Live, editable operating instructions. Versioned via proposals. */
  strategy: string;
  strategyVersion: number;
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
}

export interface ResearchBrief {
  id: string;
  cycleId: string;
  createdAt: number;
  headline: string;
  bullets: string[];
  sources: string[];
}
