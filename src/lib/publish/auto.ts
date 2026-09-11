import { pushEvent, updateState } from "@/lib/store";
import { isViewerMode } from "@/lib/viewer/mode";
import { checkXGuards } from "@/lib/publish/x-guard";
import { publishToX, splitForThread, xStatus } from "@/lib/publish/x";
import type { Draft, SwarmState } from "@/lib/types";

/**
 * Autonomous X publishing. Approved X drafts from the freshest cycles go out
 * on their own, one per scheduler tick, inside the shared-account guards
 * (minimum gap between posts, rolling daily ceiling, duplicate memory, no
 * self-interaction). Fails closed when the access keys are absent, and never
 * touches the historical backlog: only drafts younger than FRESH_WINDOW_MS
 * qualify, so switching the rail on cannot turn 50 old approvals into a
 * burst. Older approved drafts stay approved for manual publishing.
 */

const FRESH_WINDOW_MS = 6 * 3600_000;
const ERROR_BACKOFF_MS = 15 * 60_000;
/** The first ever live post is a controlled smoke test: shortest thread wins. */
const FIRST_POST_MAX_TWEETS = 3;

interface AutoPublisherState {
  nextAttemptAt: number;
  warnedNotReady: boolean;
  warnedOff: boolean;
}

declare global {
  var __lauraXAutoPublisher: AutoPublisherState | undefined;
}

function ps(): AutoPublisherState {
  return (globalThis.__lauraXAutoPublisher ??= { nextAttemptAt: 0, warnedNotReady: false, warnedOff: false });
}

function log(msg: string): void {
  console.log(`[x-auto ${new Date().toISOString()}] ${msg}`);
}

function isXChannel(d: Draft): boolean {
  return /^(x|twitter)$/i.test(d.channel.trim());
}

/** Fresh, approved, X-targeted, not yet skipped by a permanent guard verdict; newest first. */
export function autoPublishCandidates(state: SwarmState, now = Date.now()): Draft[] {
  return state.drafts
    .filter(
      (d) =>
        d.status === "approved" &&
        isXChannel(d) &&
        now - d.createdAt < FRESH_WINDOW_MS &&
        !d.autoPublishNote,
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

function isRateReason(reason: string): boolean {
  return /^(rate cap|daily cap)/.test(reason);
}

export async function runXPublishTick(state: SwarmState): Promise<void> {
  if (isViewerMode()) return;
  const s = ps();
  if (!state.settings.autoPublishX) {
    if (!s.warnedOff) {
      s.warnedOff = true;
      log("autonomous X publishing is off (settings.autoPublishX); approved drafts wait for the operator");
    }
    return;
  }
  const status = xStatus();
  if (!status.ready) {
    if (!s.warnedNotReady) {
      s.warnedNotReady = true;
      log(`idle: X access keys missing (${status.missing.join(", ")}); approved drafts queue until they land`);
    }
    return;
  }
  s.warnedNotReady = false;
  const now = Date.now();
  if (now < s.nextAttemptAt) return;

  let candidates = autoPublishCandidates(state, now);
  if (candidates.length === 0) return;

  /* Rate verdicts apply to every candidate alike: one probe answers for all. */
  const probe = await checkXGuards(candidates[0].body);
  if (probe.reasons.some(isRateReason)) return;
  if (probe.wouldBeFirstPost) {
    const short = candidates.filter((d) => splitForThread(d.body, d.kind === "thread").length <= FIRST_POST_MAX_TWEETS);
    if (short.length === 0) {
      log("first live post must be a short smoke test (≤3 tweets); no fresh draft qualifies yet");
      return;
    }
    candidates = short;
  }

  for (const draft of candidates) {
    const guard = await checkXGuards(draft.body);
    if (!guard.ok) {
      if (guard.reasons.some(isRateReason)) return;
      const note = `auto-publish skipped: ${guard.reasons.join("; ")}`;
      await updateState((st) => {
        const d = st.drafts.find((x) => x.id === draft.id);
        if (d) d.autoPublishNote = note;
        return null;
      });
      log(`${draft.id} skipped: ${guard.reasons.join("; ")}`);
      continue;
    }
    try {
      const result = await publishToX(draft.body, draft.kind === "thread");
      await updateState((st) => {
        const d = st.drafts.find((x) => x.id === draft.id);
        if (!d) return null;
        d.status = "published";
        d.reviewedAt = Date.now();
        d.publishedUrl = result.url;
        const agent = st.agents.find((a) => a.id === d.agentId);
        if (agent) {
          agent.stats.approved = Math.max(0, agent.stats.approved - 1);
          agent.stats.published += 1;
        }
        pushEvent(st, {
          kind: "draft.published",
          agentId: d.agentId,
          title: `Published to X: ${d.title}`,
          detail: `${result.tweetIds.length} post(s) · ${result.url} · autonomous rail (${guard.postsLast24h + 1}/${guard.policy.maxPostsPerDay} today)`,
          refId: d.id,
        });
        return d;
      });
      log(`published ${draft.id} by ${draft.agentId}: ${result.url} (${result.tweetIds.length} tweet(s))`);
    } catch (err) {
      s.nextAttemptAt = Date.now() + ERROR_BACKOFF_MS;
      await updateState((st) => {
        const target = st.drafts.find((x) => x.id === draft.id);
        if (target) target.autoPublishNote = `auto-publish failed: ${String(err).slice(0, 200)}`;
        pushEvent(st, {
          kind: "error",
          agentId: draft.agentId,
          title: `X auto-publish failed: ${draft.title}`,
          detail: String(err),
          refId: draft.id,
        });
        return null;
      });
      log(`publish of ${draft.id} failed (${String(err)}); backing off 15m`);
    }
    return; // one post per tick, success or failure
  }
}
