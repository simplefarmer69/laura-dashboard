import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PAGER_BASE_URL, pagerHolderSession } from "@/lib/pager/client";
import type { SwarmState } from "@/lib/types";

/**
 * The Pager Work board: LAURA hiring real people.
 *
 * Posting a job is not a message, it is an escrow. `createJob` moves the full
 * bounty into `PagerJobBoard` and it stays there until the work is approved,
 * the deadline lapses, or she cancels. That makes every job a treasury spend,
 * so it rides caps exactly like a buy does and it is proposed rather than
 * signed on the spot (`library/91-pager.md`).
 *
 * The board is verified on Robinhood Chain and its constants are read from
 * chain rather than assumed: 1% fee, one hour minimum duration, 180 day
 * maximum, 14 day approval window.
 */

export const PAGER_JOB_BOARD = "0xf08B8bAdeCB1fEf09996f0aD118B1e693BF07433" as const;
/** STONKBROKER, what the board is already paid in. */
export const PAGER_JOB_TOKEN = "0xe934e36a439c94017b64a3fece66af12099abf50" as const;

export const PAGER_JOB_CAPS = {
  /** Most STONKBROKER any single job may escrow. Board norm is 200 to 5,000. */
  maxTokenPerJob: 2_500,
  /** Most STONKBROKER she may commit across all jobs in a rolling 24h. */
  maxTokenPer24h: 5_000,
  /** Jobs left open and unfinished at once. Escrow is locked while they sit. */
  maxOpenJobs: 3,
  /** Never escrow below this much STONKBROKER left in the wallet. */
  tokenFloor: 20_000,
  /** Board bounds, enforced on chain; mirrored so a bad spec fails before gas. */
  minDurationSec: 3_600,
  maxDurationSec: 15_552_000,
  /** What she actually wants: long enough to do the work, short enough to recycle. */
  defaultDurationSec: 7 * 24 * 3_600,
} as const;

export interface PagerJobSpec {
  title: string;
  details: string;
  links: string[];
  /** Whole STONKBROKER, not wei. */
  amount: number;
  durationSec?: number;
  /** A named worker makes it a direct offer; omit for an open job anyone may take. */
  worker?: `0x${string}`;
}

export interface PagerJob {
  id: number;
  poster: string;
  worker: string;
  token: string;
  amount: string;
  deadline: number;
  status: string;
  details: { title: string; details: string; links: string[] } | null;
}

/**
 * The hash the board stores and the site checks its copy of the details
 * against. Confirmed by reproducing the on-chain hash of two live jobs:
 * keccak256 of the UTF-8 JSON of exactly these three keys, in this order.
 * Key order is part of the hash, so this object is built literally and must
 * not be spread or reordered.
 */
export function jobDetailsHash(d: { title: string; details: string; links: string[] }): `0x${string}` {
  return keccak256(toHex(JSON.stringify({ title: d.title, details: d.details, links: d.links })));
}

const BOARD_ABI = parseAbi([
  "function createJob(address token, uint128 amount, uint64 duration, bytes32 detailsHash, address worker, uint8 nftKind, uint32 nftId) payable returns (uint256)",
  "function cancel(uint256 id)",
  "function jobCount() view returns (uint256)",
  "function isHolder(address) view returns (bool)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

function rpc() {
  return process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
}

export interface JobEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * The board's own validation of the visible copy, mirrored here because it
 * runs on the wrong side of the money. The escrow is committed on chain
 * against the hash of this text, but the description is only accepted
 * afterwards, so a title or body the site rejects leaves a funded job that
 * can never show what it is asking for. Found the hard way: a six sentence
 * description passed every local check, escrowed, and was then refused.
 */
export function jobCopyProblem(d: { title: string; details: string }): string | null {
  const title = d.title.trim();
  if (title.length < 3 || title.length > 80) return `title must be 3 to 80 characters (got ${title.length})`;
  const body = d.details.trim();
  if (body.length > 900) return `description must be 900 characters or fewer (got ${body.length})`;
  const sentences = body.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
  if (sentences < 2 || sentences > 5) return `description must be 2 to 5 sentences (got ${sentences})`;
  return null;
}

/**
 * Everything that must hold before a job may be funded. Pure apart from the
 * balance read, and it fails closed: an unreadable balance is a refusal, not
 * an assumption that the money is there.
 */
export async function jobEligibility(state: SwarmState, spec: PagerJobSpec): Promise<JobEligibility> {
  const caps = PAGER_JOB_CAPS;
  if (!spec.title?.trim() || !spec.details?.trim()) return { eligible: false, reason: "a job needs a title and a description of the work" };
  const copy = jobCopyProblem(spec);
  if (copy) return { eligible: false, reason: `the board will refuse this copy after the escrow is committed: ${copy}` };
  if (!Number.isFinite(spec.amount) || spec.amount <= 0) return { eligible: false, reason: "bounty must be a positive amount of STONKBROKER" };
  if (spec.amount > caps.maxTokenPerJob) {
    return { eligible: false, reason: `bounty ${spec.amount} STONKBROKER is over the ${caps.maxTokenPerJob} per job cap` };
  }
  const duration = spec.durationSec ?? caps.defaultDurationSec;
  if (duration < caps.minDurationSec || duration > caps.maxDurationSec) {
    return { eligible: false, reason: `duration ${duration}s is outside the board's bounds (${caps.minDurationSec}s to ${caps.maxDurationSec}s)` };
  }

  const posted = state.pagerJobs ?? [];
  const open = posted.filter((j) => j.status === "open" || j.status === "accepted" || j.status === "submitted");
  if (open.length >= caps.maxOpenJobs) {
    return { eligible: false, reason: `${open.length} job(s) already open; cap is ${caps.maxOpenJobs}` };
  }
  const since = Date.now() - 24 * 3600_000;
  const spent24h = posted.filter((j) => j.postedAt >= since).reduce((n, j) => n + j.amount, 0);
  if (spent24h + spec.amount > caps.maxTokenPer24h) {
    return { eligible: false, reason: `${spent24h} STONKBROKER already committed in 24h; ${spec.amount} more passes the ${caps.maxTokenPer24h} ceiling` };
  }

  let balance: bigint;
  try {
    const client = createPublicClient({ transport: http(rpc()) });
    const me = (await pagerHolderSession()).wallet as `0x${string}`;
    balance = await client.readContract({ address: PAGER_JOB_TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [me] });
  } catch (err) {
    return { eligible: false, reason: `could not read the STONKBROKER balance, refusing to escrow blind: ${String(err).slice(0, 100)}` };
  }
  const whole = Number(balance / 10n ** 18n);
  if (whole - spec.amount < caps.tokenFloor) {
    return { eligible: false, reason: `escrowing ${spec.amount} would leave ${whole - spec.amount} STONKBROKER, under the ${caps.tokenFloor} floor` };
  }
  return { eligible: true, reason: `within caps: ${spec.amount} STONKBROKER, ${open.length + 1}/${caps.maxOpenJobs} open, ${whole} on hand` };
}

/**
 * Funds the escrow and publishes the job. Approves only the exact bounty, so
 * a bug here cannot drain more than one job's worth, and attaches the details
 * off chain afterwards: the board stores only their hash, and the board shows
 * a job with no readable description until that second call lands.
 */
export async function createPagerJob(spec: PagerJobSpec): Promise<{ jobId: number; txHash: string }> {
  const key = process.env.SWARM_WALLET_PRIVATE_KEY;
  if (!key) throw new Error("No wallet configured (set SWARM_WALLET_PRIVATE_KEY)");
  const account = privateKeyToAccount(key as `0x${string}`);
  const transport = http(rpc());
  const pub = createPublicClient({ transport });
  const chainId = await pub.getChainId();
  const wallet = createWalletClient({ account, transport, chain: { id: chainId, name: "robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc()] } } } });

  const details = { title: spec.title.trim(), details: spec.details.trim(), links: spec.links ?? [] };
  /* Last gate before money moves. The board validates this copy only after
     the escrow exists, so checking it here is the difference between a
     rejected draft and a funded job nobody can read. */
  const copy = jobCopyProblem(details);
  if (copy) throw new Error(`refusing to escrow: the board will reject this copy (${copy})`);
  const amountWei = BigInt(Math.round(spec.amount)) * 10n ** 18n;
  const duration = BigInt(spec.durationSec ?? PAGER_JOB_CAPS.defaultDurationSec);

  const allowance = await pub.readContract({ address: PAGER_JOB_TOKEN, abi: ERC20_ABI, functionName: "allowance", args: [account.address, PAGER_JOB_BOARD] });
  if (allowance < amountWei) {
    const approveHash = await wallet.writeContract({ address: PAGER_JOB_TOKEN, abi: ERC20_ABI, functionName: "approve", args: [PAGER_JOB_BOARD, amountWei] });
    await pub.waitForTransactionReceipt({ hash: approveHash });
  }

  const txHash = await wallet.writeContract({
    address: PAGER_JOB_BOARD,
    abi: BOARD_ABI,
    functionName: "createJob",
    args: [
      PAGER_JOB_TOKEN,
      amountWei,
      duration,
      jobDetailsHash(details),
      /* No named worker and no payout wallet: an open job the floor can take,
         with the worker's wallet bound when they accept. */
      spec.worker ?? "0x0000000000000000000000000000000000000000",
      0,
      0,
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`createJob reverted (${txHash})`);
  /* Read the id back rather than assuming it stepped by one from a count
     taken before the send: another holder posting in the same block would
     make that guess attach this job's description to theirs. */
  const jobId = Number(await pub.readContract({ address: PAGER_JOB_BOARD, abi: BOARD_ABI, functionName: "jobCount" }));

  const session = await pagerHolderSession();
  const attach = await fetch(`${PAGER_BASE_URL}/api/pager/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ jobId, ...details }),
  });
  if (!attach.ok) {
    /* The bounty is already escrowed at this point, so say so loudly and name
       the job: it needs either a successful retry or a cancel to get the
       money back, and silence here is what leaves one stranded. */
    const why = await attach.text().catch(() => `${attach.status}`);
    throw new Error(`job ${jobId} is funded (${txHash}) but its description was refused: ${why.slice(0, 200)}. Retry the attach or cancel the job to recover the escrow.`);
  }
  return { jobId, txHash };
}

/** The live board, for context and for checking what she already has running. */
export async function pagerJobBoard(): Promise<PagerJob[]> {
  const session = await pagerHolderSession();
  const r = await fetch(`${PAGER_BASE_URL}/api/pager/jobs`, { headers: { authorization: `Bearer ${session.token}` }, cache: "no-store" });
  const body = (await r.json()) as { jobs?: PagerJob[] };
  return body.jobs ?? [];
}

/** The board rendered for agent context: what the floor pays for, and what she already owes. */
export function jobBoardDigest(jobs: PagerJob[], mine: string): string {
  const lines = [`THE WORK BOARD (PagerJobBoard, escrow on chain, 1% of every payout funds the intern Clock In)`];
  if (!jobs.length) return `${lines[0]}\n  Board is empty.`;
  const me = mine.toLowerCase();
  for (const j of jobs.slice(0, 12)) {
    const amt = Number(BigInt(j.amount) / 10n ** 18n);
    const who = j.poster.toLowerCase() === me ? "YOURS" : j.poster.slice(0, 10);
    lines.push(`  #${j.id} [${j.status}] ${amt} STONKBROKER by ${who}: ${j.details?.title ?? "no details attached"}`);
  }
  lines.push(
    `  Caps: at most ${PAGER_JOB_CAPS.maxTokenPerJob} STONKBROKER per job, ${PAGER_JOB_CAPS.maxTokenPer24h} per 24h, ${PAGER_JOB_CAPS.maxOpenJobs} open at once. Posting escrows the bounty, so propose it, never sign it yourself.`,
  );
  return lines.join("\n");
}
