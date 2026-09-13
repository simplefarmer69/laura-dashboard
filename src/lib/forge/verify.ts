import { chromiumExecutablePath, loadPlaywright, type PlaywrightLike } from "@/lib/swarm/browser";
import { LAUNCHPAD, ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { FORGE_COMPILER_SHORT, FORGE_COMPILER_VERSION, FORGE_EVM_VERSION, FORGE_OPTIMIZER_RUNS, FORGE_SOURCE_FILE, standardJsonInput } from "@/lib/forge/compile";
import type { ForgeProject } from "@/lib/types";

/**
 * Source verification for Anvil's contracts, two independent routes:
 *
 *   1. Robinhood Blockscout (the explorer people actually open). Its API sits
 *      behind a Cloudflare challenge that refuses plain server fetches from
 *      this host (403 "Just a moment" on 2026-09-13), but a real Chromium
 *      passes it, so the request is made from inside a headless page on the
 *      explorer's own origin. Needs SWARM_BROWSER=1 like the browser worker.
 *   2. Sourcify (sourcify.dev), which lists chain 4663 as supported and takes
 *      plain HTTPS. Blockscout imports Sourcify matches, so this route also
 *      backs the first one.
 *
 * Both receive the same compiler settings compile.ts used, so a contract
 * that compiled verifies byte-for-byte or not at all.
 */

const EXPLORER = LAUNCHPAD.explorer.replace(/\/$/, "");
const SOURCIFY = "https://sourcify.dev/server";
const CHAIN_ID = ROBINHOOD_CHAIN.id;
const PAGE_TIMEOUT_MS = 30_000;
const CHALLENGE_GRACE_MS = 7_000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export function explorerContractUrl(address: string): string {
  return `${EXPLORER}/address/${address}?tab=contract`;
}

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

function log(msg: string): void {
  console.log(`[forge-verify ${new Date().toISOString()}] ${msg}`);
}

interface PageFetchResult {
  status: number;
  body: string;
}

/**
 * Runs one or more same-origin fetches from inside a Chromium page on the
 * explorer, so Cloudflare sees a browser. Returns null when Chromium is not
 * available on this host.
 */
async function explorerFetch(
  requests: Array<{ path: string; method: "GET" | "POST"; json?: unknown }>,
): Promise<PageFetchResult[] | null> {
  const pw: PlaywrightLike | null = loadPlaywright();
  if (!pw) return null;
  const browser = await pw.chromium.launch({ headless: true, executablePath: chromiumExecutablePath() });
  try {
    const context = await browser.newContext({ userAgent: UA, javaScriptEnabled: true });
    const page = await context.newPage();
    try {
      await page.goto(`${EXPLORER}/`, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      let title = await page.title();
      if (/just a moment|attention required|verify you are human/i.test(title)) {
        await page.waitForTimeout(CHALLENGE_GRACE_MS);
        title = await page.title();
        if (/just a moment|attention required|verify you are human/i.test(title)) throw new Error("explorer bot challenge not cleared");
      }
      const out: PageFetchResult[] = [];
      for (const r of requests) {
        const res = await page.evaluate(
          async (arg: { url: string; method: string; body: string | null }) => {
            const resp = await fetch(arg.url, {
              method: arg.method,
              headers: arg.body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
              body: arg.body ?? undefined,
              credentials: "same-origin",
            });
            return { status: resp.status, body: await resp.text() };
          },
          { url: `${EXPLORER}${r.path}`, method: r.method, body: r.json === undefined ? null : JSON.stringify(r.json) },
        );
        out.push(res);
      }
      return out;
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export interface VerifyStatus {
  verified: boolean;
  via: "blockscout" | "sourcify" | null;
  detail: string;
}

/** Is the source already accepted on the explorer or on Sourcify? Checks both; the explorer wins when both say yes. */
export async function checkVerified(address: string): Promise<VerifyStatus> {
  const notes: string[] = [];
  try {
    const res = await explorerFetch([{ path: `/api/v2/smart-contracts/${address}`, method: "GET" }]);
    if (res) {
      const [r] = res;
      if (r.status === 200) {
        const j = JSON.parse(r.body) as { is_verified?: boolean; is_partially_verified?: boolean; is_fully_verified?: boolean };
        if (j.is_verified || j.is_fully_verified || j.is_partially_verified) return { verified: true, via: "blockscout", detail: "explorer shows verified source" };
        notes.push("explorer: not verified yet");
      } else {
        notes.push(`explorer: HTTP ${r.status}`);
      }
    } else {
      notes.push("explorer: chromium unavailable on this host");
    }
  } catch (err) {
    notes.push(`explorer check failed: ${String(err).slice(0, 120)}`);
  }
  try {
    const r = await fetch(`${SOURCIFY}/v2/contract/${CHAIN_ID}/${address}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (r.ok) {
      const j = (await r.json()) as { match?: string | null };
      if (j.match) return { verified: true, via: "sourcify", detail: `sourcify ${j.match}; ${notes.join("; ")}` };
      notes.push("sourcify: no match yet");
    } else {
      notes.push(`sourcify: HTTP ${r.status}`);
    }
  } catch (err) {
    notes.push(`sourcify check failed: ${String(err).slice(0, 120)}`);
  }
  return { verified: false, via: null, detail: notes.join("; ") };
}

export interface SubmitOutcome {
  submitted: Array<"blockscout" | "sourcify">;
  errors: string[];
}

/** Submits the source to both verifiers; either acceptance is enough. Never throws. */
export async function submitVerification(project: ForgeProject): Promise<SubmitOutcome> {
  const address = project.contractAddress;
  if (!address) return { submitted: [], errors: ["no contract address"] };
  const submitted: SubmitOutcome["submitted"] = [];
  const errors: string[] = [];

  try {
    const res = await explorerFetch([
      {
        path: `/api/v2/smart-contracts/${address}/verification/via/flattened-code`,
        method: "POST",
        json: {
          compiler_version: FORGE_COMPILER_VERSION,
          license_type: "mit",
          source_code: project.source,
          is_optimization_enabled: true,
          optimization_runs: FORGE_OPTIMIZER_RUNS,
          contract_name: project.contractName,
          evm_version: FORGE_EVM_VERSION,
          autodetect_constructor_args: true,
        },
      },
    ]);
    if (!res) errors.push("explorer: chromium unavailable on this host");
    else {
      const [r] = res;
      if (r.status >= 200 && r.status < 300) {
        submitted.push("blockscout");
        log(`explorer accepted the verification job for ${address}: ${r.body.slice(0, 120)}`);
      } else {
        errors.push(`explorer HTTP ${r.status}: ${r.body.slice(0, 200)}`);
      }
    }
  } catch (err) {
    errors.push(`explorer submit failed: ${String(err).slice(0, 160)}`);
  }

  try {
    const r = await fetch(`${SOURCIFY}/v2/verify/${CHAIN_ID}/${address}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        stdJsonInput: standardJsonInput(project.source),
        compilerVersion: FORGE_COMPILER_SHORT,
        contractIdentifier: `${FORGE_SOURCE_FILE}:${project.contractName}`,
        creationTransactionHash: project.txHash ?? undefined,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.text();
    if (r.status === 202 || r.ok) {
      submitted.push("sourcify");
      log(`sourcify accepted the verification job for ${address}: ${body.slice(0, 120)}`);
    } else if (r.status === 409) {
      /* Already verified there. */
      submitted.push("sourcify");
    } else {
      errors.push(`sourcify HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    errors.push(`sourcify submit failed: ${String(err).slice(0, 160)}`);
  }

  return { submitted, errors };
}
