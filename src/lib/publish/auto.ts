import { pushEvent, updateState } from "@/lib/store";
import { isViewerMode } from "@/lib/viewer/mode";
import { checkXGuards, recentXPosts } from "@/lib/publish/x-guard";
import { isAuthFailure, publishToX, xStatus } from "@/lib/publish/x";
import {
  acceptAuditEdit,
  sanitizeXPost,
  xAuditMock,
  xAuditPrompt,
  xAuditSchema,
  xPostProblems,
} from "@/lib/publish/x-style";
import { generateStructured, resolveModel } from "@/lib/swarm/llm";
import { agentSystem } from "@/lib/swarm/tasks";
import { utcDate } from "@/lib/grader/score";
import type { Draft, SwarmState } from "@/lib/types";

/**
 * Autonomous X publishing. Approved X drafts from the freshest cycles go out
 * on their own, one per scheduler tick, inside the shared-account guards
 * (minimum gap between posts, rolling daily ceiling, duplicate memory, no
 * self-interaction). Fails closed when the access keys are absent, and never
 * touches the historical backlog: only drafts younger than FRESH_WINDOW_MS
 * qualify, so switching the rail on cannot turn 50 old approvals into a
 * burst. Older approved drafts stay approved for manual publishing.
 *
 * Every post is a SINGLE tweet (operator directive 2026-09-12: no threads)
 * and passes three gates in order before the network call:
 *   1. sanitizer: banned openers/sign-offs and dashes stripped in code;
 *   2. style checks: length, thread markers, filler, and repetition against
 *      the account's own recent posts (opening, closing, statistics, overlap);
 *   3. the Auditor (critic agent) reads the exact text with the recent posts
 *      beside it and passes, vetoes, or returns a light edit that code then
 *      verifies added nothing.
 * A veto rejects the draft with the auditor's reason so the producer sees it
 * next cycle under RECENT REVIEWER DECISIONS.
 */

const FRESH_WINDOW_MS = 6 * 3600_000;
const ERROR_BACKOFF_MS = 15 * 60_000;
/** A 401 means the token is gone, not that the post is bad: wait for the operator. */
const AUTH_BACKOFF_MS = 60 * 60_000;
/** Auditor calls per tick: enough to find one publishable post among fresh drafts. */
const MAX_AUDITS_PER_TICK = 2;

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

/** Marks a draft as skipped by the rail; it stays approved for the operator. */
async function skip(draftId: string, note: string): Promise<void> {
  await updateState((st) => {
    const d = st.drafts.find((x) => x.id === draftId);
    if (d) d.autoPublishNote = note;
    return null;
  });
}

/** Rejects a draft outright with the auditor's reason; the producer reads it next cycle. */
async function veto(draft: Draft, reason: string): Promise<void> {
  await updateState((st) => {
    const d = st.drafts.find((x) => x.id === draft.id);
    if (!d) return null;
    const wasApproved = d.status === "approved";
    d.status = "rejected";
    d.reviewedAt = Date.now();
    d.reviewerNote = `Auditor veto at the X gate: ${reason}`;
    d.autoPublishNote = `vetoed before posting: ${reason.slice(0, 200)}`;
    const author = st.agents.find((a) => a.id === d.agentId);
    if (author) {
      author.stats.rejected += 1;
      if (wasApproved && author.stats.approved > 0) author.stats.approved -= 1;
    }
    pushEvent(st, {
      kind: "critic.vetoed",
      agentId: "critic",
      title: `Auditor stopped an X post: ${d.title}`,
      detail: reason,
      refId: d.id,
    });
    return d;
  });
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

  const candidates = autoPublishCandidates(state, now);
  if (candidates.length === 0) return;

  /* Rate verdicts apply to every candidate alike: one probe answers for all. */
  const probe = await checkXGuards(candidates[0].body);
  if (probe.reasons.some(isRateReason)) return;

  const recent = await recentXPosts(12);
  const critic = state.agents.find((a) => a.id === "critic");
  const resolved = resolveModel(state.settings.llmModel);
  let audits = 0;

  for (const draft of candidates) {
    if (draft.kind === "thread") {
      await skip(draft.id, "not posted: threads are retired on X; the rail publishes single posts (kind \"post\") only");
      log(`${draft.id} skipped: thread kind`);
      continue;
    }

    const clean = sanitizeXPost(draft.body);
    const problems = xPostProblems(clean.text, recent);
    if (problems.length > 0) {
      await veto(draft, `style check: ${problems.join("; ")}`);
      log(`${draft.id} vetoed by style checks: ${problems.join("; ")}`);
      continue;
    }

    const guard = await checkXGuards(clean.text);
    if (!guard.ok) {
      if (guard.reasons.some(isRateReason)) return;
      await skip(draft.id, `auto-publish skipped: ${guard.reasons.join("; ")}`);
      log(`${draft.id} skipped: ${guard.reasons.join("; ")}`);
      continue;
    }

    if (audits >= MAX_AUDITS_PER_TICK) return;
    audits += 1;
    let text = clean.text;
    let auditNote = "";
    if (critic && critic.status !== "paused") {
      const author = state.agents.find((a) => a.id === draft.agentId);
      const audit = await generateStructured(resolved, {
        schema: xAuditSchema,
        system: agentSystem(critic),
        prompt: xAuditPrompt({
          post: text,
          author: author ? `${author.name} (${author.id})` : draft.agentId,
          rationale: draft.rationale,
          recent,
          today: utcDate(),
        }),
        mock: xAuditMock,
      });
      if (audit.value.verdict === "veto") {
        await veto(draft, audit.value.reason);
        log(`${draft.id} vetoed by the auditor: ${audit.value.reason.slice(0, 160)}`);
        continue;
      }
      const edited = acceptAuditEdit(text, audit.value.edited);
      if (edited && edited !== text) {
        const editProblems = xPostProblems(edited, recent);
        if (editProblems.length === 0) {
          text = edited;
          auditNote = " · auditor edit applied";
        }
      }
      auditNote += audit.usedMock ? " · auditor offline, code checks only" : " · auditor pass";
    }

    try {
      const result = await publishToX(text, false);
      await updateState((st) => {
        const d = st.drafts.find((x) => x.id === draft.id);
        if (!d) return null;
        d.status = "published";
        d.reviewedAt = Date.now();
        d.publishedUrl = result.url;
        if (text !== d.body) {
          d.rationale = `${d.rationale}\n\nPosted text (after sanitizer${auditNote.includes("edit applied") ? " and auditor edit" : ""}):\n${text}`;
        }
        const agent = st.agents.find((a) => a.id === d.agentId);
        if (agent) {
          agent.stats.approved = Math.max(0, agent.stats.approved - 1);
          agent.stats.published += 1;
        }
        pushEvent(st, {
          kind: "draft.published",
          agentId: d.agentId,
          title: `Published to X: ${d.title}`,
          detail: `single post · ${result.url} · autonomous rail (${guard.postsLast24h + 1}/${guard.policy.maxPostsPerDay} today)${auditNote}${clean.stripped.length > 0 ? ` · stripped ${clean.stripped.join(", ")}` : ""}`,
          refId: d.id,
        });
        return d;
      });
      log(`published ${draft.id} by ${draft.agentId}: ${result.url}${auditNote}`);
    } catch (err) {
      if (isAuthFailure(err)) {
        /* Expired or revoked token: the draft is fine, the credential is not.
           Leave the draft eligible, stop hammering the API, tell the operator
           once per backoff window. */
        s.nextAttemptAt = Date.now() + AUTH_BACKOFF_MS;
        await updateState((st) => {
          pushEvent(st, {
            kind: "error",
            agentId: "system",
            title: "X posting credentials rejected (401)",
            detail: `The X user token no longer authenticates; posts and mention replies are paused until X_OAUTH2_ACCESS_TOKEN is refreshed or the OAuth 1.0a access token pair is installed. Approved posts stay queued. Draft waiting: ${draft.title}`,
            refId: draft.id,
          });
          return null;
        });
        log(`publish of ${draft.id} refused with 401: token expired or revoked; pausing the rail 60m, draft stays queued`);
        return;
      }
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
