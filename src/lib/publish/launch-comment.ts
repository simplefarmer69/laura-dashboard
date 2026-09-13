import { pushEvent, redactSecrets, updateState } from "@/lib/store";
import { isViewerMode } from "@/lib/viewer/mode";
import { isAuthFailure, replyOnX, xStatus } from "@/lib/publish/x";
import { sanitizeXPost, TWEET_MAX } from "@/lib/publish/x-style";
import { findWatchedOrRequested } from "@/lib/publish/x-watch";
import { generateStructured, resolveModel } from "@/lib/swarm/llm";
import { SWARM_CHARTER } from "@/lib/swarm/roster";
import { launchCommentPrompt, launchCommentSchema } from "@/lib/swarm/tasks";
import { PUBLIC_PERSONA } from "@/lib/chat/laura";
import type { LaunchProposal, SwarmState } from "@/lib/types";

/**
 * Launch comment rail (operator directive 2026-09-13: "comment if she
 * launches a token based on their context"). When a launch carries
 * inspiredBy (a watched voice's post or a mention that asked for it) and the
 * token is live on the floor, LAURA leaves ONE reply under that post naming
 * the fact it answers, what she launched, and the token link.
 *
 * Caps (code-level): one comment per tick, COMMENT_MIN_GAP_MS between
 * comments, MAX_COMMENTS_PER_DAY, source post no older than MAX_POST_AGE_MS
 * at comment time, MAX_ATTEMPTS per launch. Fails closed without a model.
 */

const COMMENT_MIN_GAP_MS = 30 * 60_000;
const MAX_COMMENTS_PER_DAY = 4;
const MAX_POST_AGE_MS = 48 * 3600_000;
const MAX_ATTEMPTS = 3;
const ERROR_BACKOFF_MS = 20 * 60_000;
const AUTH_BACKOFF_MS = 60 * 60_000;
const DAY_MS = 24 * 3600_000;

interface RailState {
  nextAttemptAt: number;
}

declare global {
  var __lauraLaunchComments: RailState | undefined;
}

function rs(): RailState {
  return (globalThis.__lauraLaunchComments ??= { nextAttemptAt: 0 });
}

function log(msg: string): void {
  console.log(`[launch-comment ${new Date().toISOString()}] ${msg}`);
}

export function tokenPageUrl(address: string): string {
  return `https://brokertools.info/token/${address.toLowerCase()}`;
}

/** Launches live on the floor whose source post has not been answered yet. */
export function commentCandidates(state: SwarmState): LaunchProposal[] {
  return state.launches.filter(
    (l) =>
      l.status === "deployed" &&
      !!l.inspiredBy &&
      !!l.tokenAddress &&
      !!l.armedAt &&
      !l.inspiredReply &&
      (l.inspiredReplyAttempts ?? 0) < MAX_ATTEMPTS,
  );
}

async function giveUp(launchId: string, reason: string): Promise<void> {
  await updateState((s) => {
    const l = s.launches.find((x) => x.id === launchId);
    if (!l) return;
    l.inspiredReplyAttempts = MAX_ATTEMPTS;
    pushEvent(s, {
      kind: "launch.commented",
      agentId: "system",
      title: `No comment under the source post for ${l.name} ($${l.symbol})`,
      detail: reason,
      refId: l.id,
    });
  });
}

export async function runLaunchCommentTick(state: SwarmState): Promise<void> {
  if (isViewerMode()) return;
  if (!state.settings.autoPublishX) return;
  const r = rs();
  const now = Date.now();
  if (now < r.nextAttemptAt) return;
  const candidates = commentCandidates(state);
  if (candidates.length === 0) return;
  if (!xStatus().ready) return;

  const commented = state.launches.filter((l) => l.inspiredReply).map((l) => l.inspiredReply!);
  const lastAt = Math.max(0, ...commented.map((c) => c.at));
  if (now - lastAt < COMMENT_MIN_GAP_MS) return;
  if (commented.filter((c) => now - c.at < DAY_MS).length >= MAX_COMMENTS_PER_DAY) return;

  const launch = candidates.sort((a, b) => (a.armedAt ?? 0) - (b.armedAt ?? 0))[0];
  const insp = launch.inspiredBy!;
  const post = await findWatchedOrRequested(insp.tweetId);
  const postText = post?.text ?? insp.text;
  const postAgeMs = post ? now - new Date(post.createdAt).getTime() : MAX_POST_AGE_MS;
  if (postAgeMs > MAX_POST_AGE_MS) {
    await giveUp(launch.id, `The source post by @${insp.author} is ${Math.round(postAgeMs / 3600_000)}h old; a reply now would read as spam.`);
    return;
  }

  const resolved = resolveModel(state.settings.llmModel);
  const tokenUrl = tokenPageUrl(launch.tokenAddress!);
  const recent = commented
    .slice(-5)
    .map((c) => `- ${c.text}`)
    .join("\n");
  const out = await generateStructured(resolved, {
    schema: launchCommentSchema,
    system: `${SWARM_CHARTER}\n\n${PUBLIC_PERSONA}`,
    prompt: launchCommentPrompt({
      launch,
      source: insp.source,
      author: insp.author,
      postText,
      postAgeHours: postAgeMs / 3600_000,
      tokenUrl,
      recent,
    }),
    mock: () => ({ skip: true, reason: "No live model; the comment rail never sends canned replies.", reply: "" }),
  });
  if (out.usedMock) return;

  await updateState((s) => {
    const l = s.launches.find((x) => x.id === launch.id);
    if (l) l.inspiredReplyAttempts = (l.inspiredReplyAttempts ?? 0) + 1;
  });

  if (out.value.skip || !out.value.reply.trim()) {
    log(`skip comment for ${launch.symbol}: ${out.value.reason.slice(0, 140)}`);
    if ((launch.inspiredReplyAttempts ?? 0) + 1 >= MAX_ATTEMPTS) await giveUp(launch.id, out.value.reason);
    return;
  }

  let text = redactSecrets(sanitizeXPost(out.value.reply).text);
  const allowed = insp.source === "mention" ? insp.author.toLowerCase() : null;
  text = text.replace(/@(\w+)/g, (full, h: string) => (allowed && h.toLowerCase() === allowed ? full : h));
  text = text.replace(/(^|\s)#\w+/g, "$1").replace(/\s{2,}/g, " ").trim();
  if (!text.includes(tokenUrl)) text = `${text} ${tokenUrl}`.trim();
  if (text.length > TWEET_MAX) {
    log(`comment for ${launch.symbol} too long after the link (${text.length}); waiting for the next attempt`);
    return;
  }

  try {
    const posted = await replyOnX(text, insp.tweetId);
    await updateState((s) => {
      const l = s.launches.find((x) => x.id === launch.id);
      if (!l) return;
      l.inspiredReply = { at: Date.now(), id: posted.id, url: posted.url, text };
      pushEvent(s, {
        kind: "launch.commented",
        agentId: l.designer === "tokenintel" ? "tokenintel" : "mint",
        title: `Commented under @${insp.author}'s post with ${l.name} ($${l.symbol})`,
        detail: `${text} · ${posted.url}`,
        refId: posted.id,
      });
    });
    log(`commented under @${insp.author} (${insp.tweetId}) with ${launch.symbol}: ${posted.url}`);
  } catch (err) {
    if (isAuthFailure(err)) {
      r.nextAttemptAt = Date.now() + AUTH_BACKOFF_MS;
      log(`comment refused with 401; pausing 60m`);
    } else {
      r.nextAttemptAt = Date.now() + ERROR_BACKOFF_MS;
      log(`comment failed (${String(err).slice(0, 160)}); backing off 20m`);
    }
  }
}
