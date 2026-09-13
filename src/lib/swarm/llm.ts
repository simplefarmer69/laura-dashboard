import { generateObject, generateText, type LanguageModel, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";
import type { LlmProvider } from "@/lib/types";

export interface ResolvedModel {
  provider: LlmProvider;
  modelId: string;
  model: LanguageModel | null;
}

/* claude-fable-5-1 per operator directive 2026-09-12 (evening), reversing the
   same-day cost cut to claude-fable-5 once the API key was migrated. */
const DEFAULT_MODELS: Record<Exclude<LlmProvider, "mock">, string> = {
  anthropic: "claude-fable-5-1",
  openai: "gpt-4.1-mini",
};

export function resolveModel(overrideModel?: string): ResolvedModel {
  const forced = process.env.SWARM_LLM_PROVIDER as LlmProvider | undefined;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const pick: LlmProvider =
    forced ?? (anthropicKey ? "anthropic" : openaiKey ? "openai" : "mock");

  switch (pick) {
    case "anthropic": {
      if (!anthropicKey) return { provider: "mock", modelId: "mock", model: null };
      const id = overrideModel || DEFAULT_MODELS.anthropic;
      return { provider: "anthropic", modelId: id, model: createAnthropic({ apiKey: anthropicKey })(id) };
    }
    case "openai": {
      if (!openaiKey) return { provider: "mock", modelId: "mock", model: null };
      const id = overrideModel || DEFAULT_MODELS.openai;
      return { provider: "openai", modelId: id, model: createOpenAI({ apiKey: openaiKey })(id) };
    }
    case "mock":
      return { provider: "mock", modelId: "mock", model: null };
    default: {
      const _exhaustive: never = pick;
      return _exhaustive;
    }
  }
}

export interface StructuredCall<T> {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /** Deterministic fallback used when no provider key is configured or the call fails. */
  mock: () => T;
}

/**
 * Compact "path: code (limit)" list pulled from a zod error message, so the
 * one-line failure log names the field that broke instead of only the first
 * 300 chars of the model's output (which never reach the failing field).
 */
function schemaIssues(cause: string): string {
  const start = cause.indexOf("Error message: ");
  const jsonText = start >= 0 ? cause.slice(start + "Error message: ".length) : cause;
  try {
    const parsed = JSON.parse(jsonText) as Array<{ code?: string; path?: Array<string | number>; maximum?: number; minimum?: number }>;
    if (!Array.isArray(parsed)) return "unparsed";
    return parsed
      .slice(0, 4)
      .map((i) => `${(i.path ?? []).join(".") || "$"}: ${i.code ?? "?"}${i.maximum !== undefined ? ` >${i.maximum}` : ""}${i.minimum !== undefined ? ` <${i.minimum}` : ""}`)
      .join("; ");
  } catch {
    const m = /"path":\s*\[([^\]]*)\]/.exec(cause);
    return m ? m[1].replace(/["\s]/g, "") : "unparsed";
  }
}

/**
 * Hard wall-clock cap per model call. On 2026-09-12 the host was suspended
 * mid-request (22:10 to 23:56 UTC) and the socket never errored, so the cycle
 * hung on one call for two hours with the in-flight lock held. A timed-out
 * call falls into the same repair/mock path as any other failure.
 */
const LLM_CALL_TIMEOUT_MS = Number(process.env.SWARM_LLM_TIMEOUT_MS ?? 4 * 60_000);

export async function generateStructured<T>(
  resolved: ResolvedModel,
  call: StructuredCall<T>,
): Promise<{ value: T; usedMock: boolean; repaired: boolean }> {
  if (!resolved.model) return { value: call.mock(), usedMock: true, repaired: false };
  try {
    const { object } = await generateObject({
      model: resolved.model,
      schema: call.schema,
      system: call.system,
      prompt: call.prompt,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
    });
    return { value: object, usedMock: false, repaired: false };
  } catch (err) {
    /* One repair attempt: feed the validation failure and the raw output back
       so the model can fix its own JSON instead of losing the whole turn. */
    const e = err as { text?: string; cause?: { message?: string } };
    const cause = e.cause?.message ?? String(err);
    console.error(
      `[llm] ${resolved.provider}/${resolved.modelId} schema failure [${schemaIssues(cause)}] (${cause.slice(0, 200)}), attempting repair`,
    );
    try {
      const { object } = await generateObject({
        model: resolved.model,
        schema: call.schema,
        system: call.system,
        prompt: `${call.prompt}\n\nYOUR PREVIOUS ATTEMPT FAILED SCHEMA VALIDATION.\nValidation error: ${cause.slice(0, 1200)}\nPrevious output (may be truncated):\n${(e.text ?? "").slice(0, 3000)}\n\nReturn a corrected response that satisfies the schema exactly. Respect every min/max length and enum.`,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
      });
      return { value: object, usedMock: false, repaired: true };
    } catch (err2) {
      console.error(`[llm] ${resolved.provider}/${resolved.modelId} repair failed, using mock:`, err2);
      return { value: call.mock(), usedMock: true, repaired: false };
    }
  }
}

export interface TextCall {
  system: string;
  messages: ModelMessage[];
  /** Deterministic fallback used when no provider key is configured or the call fails. */
  mock: () => string;
}

export async function generateChat(
  resolved: ResolvedModel,
  call: TextCall,
): Promise<{ text: string; usedMock: boolean }> {
  if (!resolved.model) return { text: call.mock(), usedMock: true };
  try {
    const { text } = await generateText({
      model: resolved.model,
      system: call.system,
      messages: call.messages,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
    });
    return { text, usedMock: false };
  } catch (err) {
    console.error(`[llm] ${resolved.provider}/${resolved.modelId} chat failed, using mock:`, err);
    return { text: call.mock(), usedMock: true };
  }
}
