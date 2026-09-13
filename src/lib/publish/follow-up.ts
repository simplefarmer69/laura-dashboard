import { replyOnX } from "@/lib/publish/x";
import { sanitizeXPost, xPostProblems } from "@/lib/publish/x-style";
import type { Draft } from "@/lib/types";

export interface FollowUpResult {
  url: string | null;
  note: string;
}

/**
 * The one reply a contract announcement carries (how the read and write
 * functions work, with the page that explains every one). Posted under the
 * announcement right after it lands. Format rules apply (length, hashtags,
 * emoji, filler, thread markers); the repetition rules do not, since the
 * reply belongs to the post above it. Not a thread: exactly one reply, never
 * numbered. Outside the daily post cap: the cap counts posts, and this reply
 * exists only because its post just did. Never throws: a lost reply is a
 * note on the event, the announcement stands.
 */
export async function postFollowUp(draft: Draft, firstTweetId: string): Promise<FollowUpResult> {
  const raw = draft.followUp?.trim();
  if (!raw) return { url: null, note: "" };
  const clean = sanitizeXPost(raw).text;
  const problems = xPostProblems(clean, [], { skipRepeatChecks: true });
  if (problems.length > 0) return { url: null, note: ` · usage reply not posted: ${problems.join("; ")}` };
  try {
    const posted = await replyOnX(clean, firstTweetId);
    return { url: posted.url, note: ` · usage reply posted: ${posted.url}` };
  } catch (err) {
    return { url: null, note: ` · usage reply failed: ${String(err).slice(0, 160)}` };
  }
}
