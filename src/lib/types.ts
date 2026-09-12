import type { PadLane } from "@/lib/launchpad/contracts";

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
  /** Distinct $STONKBROKER holders (Blockscout counters); null when the indexer is unreachable */
  tokenHolders?: number | null;
  /** Distinct broker NFT holders (Blockscout counters); null when the indexer is unreachable */
  nftHolders?: number | null;
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
  /** Latest tweets from operator-owned accounts (ClutchMarkets, personal). Optional: absent on pre-tracking snapshots. */
  tracked?: { username: string; tweets: IntelTweet[] }[];
  /** Latest originals from the crypto KOL + company watchlist (Ansem, Cobie, Uniswap…). Optional: absent on older snapshots. */
  watch?: IntelTweet[];
  /** Founder tweets engaging operator accounts or stock-token themes — the operator's #1 catalyst. Optional: absent on pre-tracking snapshots. */
  catalysts?: IntelTweet[];
  /** Top engaged meme-stock / stock-token conversation on X in the last 24h (retail mood, not about us). Optional: absent on older snapshots. */
  pulse?: IntelTweet[];
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
  /**
   * DexScreener read of new/trending Robinhood Chain launches. Optional:
   * snapshots recorded before the radar existed lack the field; null when the
   * fetch failed this cycle.
   */
  launchRadar?: LaunchRadar | null;
  /**
   * Live TVL read: DefiLlama protocol TVL plus the Smart LP vault fleet.
   * Optional: snapshots recorded before the fetcher existed lack the field;
   * null when both sources failed this cycle.
   */
  tvl?: IntelTvl | null;
  /**
   * BrokerTools (brokertools.info) read: live Robinhood Chain DEX trade tape
   * and Stonklauncher index from an independent indexer. Optional for the
   * same archive-compatibility reason; null when the fetch failed.
   */
  brokerTools?: BrokerToolsIntel | null;
  /**
   * Cross-market meme-stock read (DexScreener search + top boosts): stock
   * tape on this chain, meme-stock tokens anywhere, boosted narratives.
   * Optional for archive compatibility; null when the fetch failed.
   */
  memeMarket?: MemeMarketIntel | null;
  /** Endpoints that returned real data this cycle. */
  sources: string[];
  warnings: string[];
}

/** Live TVL snapshot: DefiLlama protocol listing + Smart LP vault fleet. */
export interface IntelTvl {
  fetchedAt: number;
  /** Protocol TVL on Robinhood Chain per DefiLlama (staking excluded). */
  protocolTvlUsd: number | null;
  /** TVL change vs ~24h ago, percent; null when the series is too short. */
  change24hPct: number | null;
  /** TVL change vs ~7d ago, percent; null when the series is too short. */
  change7dPct: number | null;
  /** Smart LP (Safety Deposit Box) vault fleet TVL from the on-chain lens read. */
  smartLpTvlUsd: number | null;
  /** Vault count behind smartLpTvlUsd. */
  smartLpVaults: number | null;
}

/** One symbol aggregated from the BrokerTools DEX trade tape. */
export interface BrokerToolsSymbolFlow {
  symbol: string;
  trades: number;
  usd: number;
}

/** One Stonklauncher launch as indexed by BrokerTools. */
export interface BrokerToolsLaunch {
  symbol: string;
  mcapUsd: number | null;
  buyers: number | null;
  phase: string | null;
}

/**
 * READ-ONLY chain intel from brokertools.info, an independent Robinhood
 * Chain explorer/indexer. Feeds prompts only — never any treasury or launch
 * execution path.
 */
export interface BrokerToolsIntel {
  fetchedAt: number;
  /** Trades in the latest tape page (~120 most recent chain-wide DEX trades). */
  tapeTrades: number;
  /** Minutes the tape page spans (recency signal for chain activity). */
  tapeSpanMin: number | null;
  buyUsd: number;
  sellUsd: number;
  /** Most-traded symbols in the tape by USD, descending. */
  topSymbols: BrokerToolsSymbolFlow[];
  /** $STONKBROKER trades present in the tape. */
  missionTrades: number;
  /** $STONKBROKER net flow in the tape (buys minus sells), USD. */
  missionNetUsd: number;
  /** Total launches the BrokerTools Stonklauncher index tracks. */
  launchesTotal: number | null;
  /** Top launches by market cap. */
  topLaunches: BrokerToolsLaunch[];
}

/** One token on the Robinhood Chain launch radar (its deepest DexScreener pair). */
export interface LaunchRadarToken {
  address: string;
  name: string;
  symbol: string;
  dexId: string;
  /** Pair creation time (ms since epoch); null when DexScreener omits it. */
  pairCreatedAt: number | null;
  volume24hUsd: number;
  liquidityUsd: number | null;
  priceChange24hPct: number | null;
  marketCapUsd: number | null;
  /** Token appears in DexScreener's paid boosts feed (actively promoted). */
  boosted: boolean;
}

/**
 * READ-ONLY market intel from DexScreener: what is launching/trending on
 * Robinhood Chain right now. Feeds prompts only — never any treasury or
 * launch execution path.
 */
export interface LaunchRadar {
  fetchedAt: number;
  /** New/active non-mission tokens, deepest pair each, sorted by 24h volume. */
  tokens: LaunchRadarToken[];
  /** $STONKBROKER's own deepest pair stats when DexScreener lists it. */
  mission: LaunchRadarToken | null;
}

/** One meme token anywhere on DexScreener that a meme-stock search surfaced. */
export interface MemeMarketToken {
  chainId: string;
  symbol: string;
  name: string;
  /** Quote asset of the deepest pair (which lane the market chose). */
  quoteSymbol: string;
  pairCreatedAt: number | null;
  volume24hUsd: number;
  marketCapUsd: number | null;
  priceChange24hPct: number | null;
  /** DexScreener profile blurb when the token bought a boost (narrative hint). */
  blurb: string | null;
}

/** A tokenized stock on Robinhood Chain and the retail volume it pulled across all its pools. */
export interface StockTapeEntry {
  symbol: string;
  name: string;
  pools: number;
  volume24hUsd: number;
  priceChange24hPct: number | null;
}

/**
 * READ-ONLY cross-market read for launch design (operator directive
 * 2026-09-11: Mint must design from DexScreener + X context, not from
 * protocol stats alone). Which tokenized stocks retail is actually trading
 * on this chain today, which meme-stock-themed tokens pull volume on any
 * chain, and what the top paid boosts are pitching. Feeds prompts only.
 */
export interface MemeMarketIntel {
  fetchedAt: number;
  stockTape: StockTapeEntry[];
  memes: MemeMarketToken[];
  boosted: MemeMarketToken[];
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
  | "watcher"
  | "researcher"
  | "narrative"
  | "steward"
  | "bd"
  | "analyst"
  | "growth"
  | "vault"
  | "critic"
  | "mint"
  | "builder"
  | "coach"
  | "sage"
  | "trainer"
  | "smartlp"
  | "nftintel"
  | "tokenintel";

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
  /** Why the autonomous X rail skipped or failed this draft (it stays approved for manual publishing). */
  autoPublishNote?: string | null;
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
  /**
   * Utility-build execution: lets the builder agent spend tiny capped
   * amounts acquiring supply of LAURA's own launched tokens and deploy
   * audited utility contract templates for them. OFF by default -- the
   * builder still proposes projects (visible in state + dashboard), but
   * nothing spends or deploys until the VM operator flips this on. Hard
   * code-level caps in BUILDER_CAPS apply regardless of this flag.
   */
  autoExecuteUtility: boolean;
  /**
   * Mint freedom: the wide launch mandate. When true the speech gate runs at
   * the freedom pace (no cooldown after a deploy, up to 6 open specs) so
   * approved launches flow as fast as Mint has something worth saying; there
   * is no daily count cap. The hard LAUNCH_CAPS (spend/deploy, pacing gap,
   * wallet floor), live pad-bounds revalidation, weekend stock-lane gate,
   * duplicate dedupe and the funded wallet all still apply and fail closed.
   * Kill switch: flip off to return to the legacy pace (12h cooldown, 2 open
   * specs).
   */
  mintFreedom: boolean;
  /**
   * Autonomous X publishing: approved X drafts from the freshest cycles post
   * on their own, one per tick, inside the shared-account guards (30 min
   * between posts, 6 per 24h, duplicate memory, no self-interaction). Fails
   * closed while X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET are absent. Older
   * approved drafts never auto-post. Kill switch: flip off for a manual gate.
   */
  autoPublishX: boolean;
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
  /** Locked-LP swap fees collected from a bonded launch's pool via the lock NFT (StonkUpLockerCL.collectFees). */
  | "fees.claimed"
  /** Watcher's per-cycle on-chain state read (treasury, pools, LP, earnings). */
  | "onchain.observed"
  /** A Robinhood founder engaged an operator account or a stock-token theme — priority catalyst. */
  | "intel.catalyst"
  /** An agent opened a thread in The Cafe Bar. */
  | "forum.thread"
  /** An agent posted a reply in The Cafe Bar. */
  | "forum.post"
  /** Vault's treasury action recommendation — advisory; execution stays in capped paths. */
  | "treasury.proposed"
  | "treasury.buy"
  | "treasury.lp"
  | "treasury.stake"
  | "treasury.exit"
  /** Builder designed a utility project for one of LAURA's launched tokens. */
  | "utility.proposed"
  | "utility.approved"
  | "utility.rejected"
  /** Builder acquired a small capped bag of the target token to fund the utility. */
  | "utility.acquired"
  /** Utility contract deployed (and funded, for faucet kinds) or dashboard surface shipped. */
  | "utility.shipped"
  | "utility.failed"
  | "tuner.adjusted"
  | "skill.updated"
  /** Sage rewrote or created one library doc through the allowlisted write path. */
  | "library.updated"
  | "swarm.health"
  | "error";

export interface SwarmEvent {
  id: string;
  ts: number;
  kind: SwarmEventKind;
  agentId: AgentId | ForumModeratorId | "grader" | "operator" | "system";
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
  /** Quote lane pad the launch deploys on (see launchpad/lanes.ts) */
  lane: PadLane;
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
  /**
   * Advanced pad options (2026-09-11, operator-directed; each verified by
   * simulation against the live pads). Optional so launches queued before
   * these existed keep deploying; the deploy path applies the proven defaults
   * (openEnded true, eoaOnly false, maxBuyPpm 0, bondVenue 0, unsoldMode 0).
   * openEnded=false and sellsEnabled=false REVERT on every V2 pad today —
   * validation refuses them until the launcher enables those modes.
   */
  /** Must be true today: closed-window sales revert BadParam() on all V2 pads */
  openEnded?: boolean;
  /** true = only externally-owned accounts may buy (anti-bot; verified accepted) */
  eoaOnly?: boolean;
  /** Per-wallet max buy in parts-per-million of supply (anti-snipe whale cap; verified accepted); 0 = uncapped */
  maxBuyPpm?: number;
  /** Graduation venue: 0 = StonkUp CL locker (proven), 1 = Uniswap V3 venue (verified accepted) */
  bondVenue?: number;
  /** Unsold-supply behavior at bond: 0 = proven default, 1 = alternate (verified accepted) */
  unsoldMode?: number;
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
  /** Logo composition (orbital, poster, badge, glitch, minimal); seeded when absent */
  artStyle?: string | null;
  /** Image search phrase; when set the logo is a real web image sourced via the Chromium worker (procedural art is the fallback) */
  imageQuery?: string | null;
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
  lane: PadLane;
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
  /**
   * Locked-LP fee stream (exists only once the launch is bonded): the pad
   * permanently locks the graduation pool but mints the lock NFT, which
   * carries the fee-claim right, to the CREATOR. LAURA holds it and collects
   * 80% of the pool's swap fees via StonkUpLockerCL.collectFees (20% protocol
   * cut, FeeMode CollectTwentyPercent). Absent on entries written before this
   * capability existed.
   */
  lockIds?: string[];
  /** True when the lock is staked in a gauge (swap fees then go to voters; collect is skipped). */
  lpStaked?: boolean;
  /** Uncollected creator share of pool swap fees, quote-token side (simulated collectFees read). */
  lpPendingQuote?: number;
  /** Uncollected creator share, launch-token side. */
  lpPendingToken?: number;
  /** Cumulative collected via our own collectFees sends, quote side. */
  lpCollectedQuote?: number;
  /** Cumulative collected, launch-token side. */
  lpCollectedToken?: number;
  lpLastCollectAt?: number | null;
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

/**
 * One Smart LP position on the Stonk Exchange (vDEX, powered by up.) —
 * a full-range STONKBROKER/WETH concentrated-liquidity NFT, optionally
 * staked in the pool's gauge for $UP emissions.
 */
export interface TreasuryLpPosition {
  id: string;
  ts: number;
  /** Position NFT id on the vDEX NonfungiblePositionManager */
  tokenId: string;
  pool: string;
  /** WETH provided at entry (native ETH, wrapped by the manager) */
  ethIn: number;
  /** $STONKBROKER provided at entry */
  stonkIn: number;
  /** Position liquidity (uint128 as string) */
  liquidity: string;
  mintTxHash: string;
  /** Gauge the NFT is staked in (earns $UP emissions); null = unstaked, earning swap fees */
  gauge: string | null;
  stakeTxHash: string | null;
  /** Live value estimate, refreshed by the treasury tick */
  currentEthValue?: number;
  currentStonkValue?: number;
  /** Pending $UP rewards when staked (readable from the gauge) */
  pendingUpRewards?: number;
  valueUpdatedAt?: number;
  /** Set when the position was withdrawn back to the wallet */
  exitedAt?: number | null;
  exitTxHash?: string | null;
}

/* ------------------------------ Utility builds ----------------------------- */

/**
 * What the builder is allowed to ship. Contract kinds map 1:1 to audited,
 * ownerless Solidity templates precompiled into the repo (src/lib/builder/
 * artifacts.json); dashboard kinds ship as snapshot data only.
 */
export type UtilityKind =
  /** Ownerless FaucetDrip contract funded with LAURA's acquired bag */
  | "faucet-drip"
  /** Ownerless BurnPledge contract: burn-to-signal leaderboard, no custody */
  | "burn-pledge"
  /** Dashboard-rendered holder leaderboard concept (no chain action) */
  | "holder-leaderboard"
  /** Dashboard-rendered token lore/quest page concept (no chain action) */
  | "gated-lore";

export type UtilityStatus = "pending" | "approved" | "rejected" | "shipped" | "failed";

/** One executed supply acquisition for a utility project (tiny, hard-capped). */
export interface UtilityAcquisition {
  ts: number;
  /** Native ETH spent on the bonded-pool path (0 when bought on the curve) */
  ethIn: number;
  /** WETH spent on the curve path via pad.buy (0 on the pool path) */
  wethIn: number;
  /** Tokens received (wallet balance delta, 18 decimals assumed) */
  tokensOut: number;
  txHash: string;
  venue: "curve" | "pool";
}

/** Deployment record for contract-kind utility projects. */
export interface UtilityDeploy {
  ts: number;
  contractAddress: string;
  txHash: string;
  /** Funding transfer for faucet kinds; null for non-custodial templates */
  fundTxHash: string | null;
  /** Tokens moved into the contract at funding time */
  fundedTokens: number;
}

/**
 * A builder utility project: give one of LAURA's own launched tokens a real
 * function (faucet, burn game, leaderboard...). Flows through the same
 * pending -> approved queue as launches; execution additionally gates on
 * settings.autoExecuteUtility plus BUILDER_CAPS.
 */
export interface UtilityProject {
  id: string;
  cycleId: string;
  createdAt: number;
  /** Target token: must be one of LAURA's own deployed launches */
  tokenAddress: string;
  tokenSymbol: string;
  /** state.launches[].id this project targets (null if matched by address only) */
  launchProposalId: string | null;
  kind: UtilityKind;
  title: string;
  concept: string;
  /** The concrete function this gives holders, in plain words */
  utility: string;
  rationale: string;
  /** Whether the plan includes acquiring a small bag first (required for faucet-drip) */
  wantsAcquisition: boolean;
  /** Faucet template params (faucet-drip only); clamped by the executor */
  faucetClaimTokens: number | null;
  faucetIntervalHours: number | null;
  status: UtilityStatus;
  reviewedAt: number | null;
  reviewerNote: string | null;
  acquisition: UtilityAcquisition | null;
  deploy: UtilityDeploy | null;
  shippedAt: number | null;
  error: string | null;
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
  /** Cumulative creator fees flushed by our own claims (protocol revenue actually banked). */
  totalClaimedQuote?: number;
  /** Uncollected locked-LP swap fees across bonded launches, quote side (creator's 80% share). */
  totalLpPendingQuote?: number;
  /** Cumulative locked-LP swap fees collected, quote side. */
  totalLpCollectedQuote?: number;
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
  /** Smart LP positions on the Stonk Exchange vDEX (caps computed from this). */
  treasuryLp?: TreasuryLpPosition[];
  /** Builder utility projects for LAURA's launched tokens (caps computed from this). */
  utilityProjects?: UtilityProject[];
  /** The Cafe Bar — the swarm's open forum. Absent before the venue existed. */
  forum?: ForumThread[];
  /** UTC date the auto-tuner last ran (it runs at most once per day). */
  lastTuneDate: string | null;
}

/* ------------------------------- The Cafe Bar ------------------------------ */

/**
 * The Cafe Bar's host, Tabs the barkeep. A forum only persona: it takes a
 * dedicated turn at the end of every round with powers the agents lack
 * (closing tabs, herding drift, pouring topics from the wire), but it is
 * never a cycle agent and never appears in the roster or the pipeline.
 */
export type ForumModeratorId = "barkeep";

/** Anyone who can speak in The Cafe Bar: the cycle agents plus the host. */
export type ForumAuthorId = AgentId | ForumModeratorId;

export type ForumTopicTag =
  | "mission"
  | "growth"
  | "on-chain"
  | "narrative"
  | "ops"
  | "ideas"
  | "off-topic";

export interface ForumPost {
  id: string;
  threadId: string;
  agentId: ForumAuthorId;
  ts: number;
  /** Which forum round created this post (round = one venue pass by all agents). */
  roundId: string;
  body: string;
}

export interface ForumThread {
  id: string;
  title: string;
  tag: ForumTopicTag;
  createdBy: ForumAuthorId;
  createdAt: number;
  status: "open" | "archived";
  posts: ForumPost[];
  /**
   * Who archived the thread: the host by judgment, or "system" when the
   * venue caps in tidyVenue() did it. Absent on threads archived before
   * closure tracking existed.
   */
  closedBy?: ForumAuthorId | "system";
  /** Public reason the thread closed, one or two plain sentences. */
  closedReason?: string;
  closedAt?: number;
}

export interface ResearchBrief {
  id: string;
  cycleId: string;
  createdAt: number;
  headline: string;
  bullets: string[];
  sources: string[];
}
