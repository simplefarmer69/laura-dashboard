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

const DEFAULT_MODELS: Record<Exclude<LlmProvider, "mock">, string> = {
  anthropic: "claude-sonnet-4-5",
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

export async function generateStructured<T>(
  resolved: ResolvedModel,
  call: StructuredCall<T>,
): Promise<{ value: T; usedMock: boolean }> {
  if (!resolved.model) return { value: call.mock(), usedMock: true };
  try {
    const { object } = await generateObject({
      model: resolved.model,
      schema: call.schema,
      system: call.system,
      prompt: call.prompt,
      maxRetries: 2,
    });
    return { value: object, usedMock: false };
  } catch (err) {
    /* One repair attempt: feed the validation failure and the raw output back
       so the model can fix its own JSON instead of losing the whole turn. */
    const e = err as { text?: string; cause?: { message?: string } };
    const cause = e.cause?.message ?? String(err);
    console.error(
      `[llm] ${resolved.provider}/${resolved.modelId} schema failure (${cause.slice(0, 300)}), attempting repair`,
    );
    try {
      const { object } = await generateObject({
        model: resolved.model,
        schema: call.schema,
        system: call.system,
        prompt: `${call.prompt}\n\nYOUR PREVIOUS ATTEMPT FAILED SCHEMA VALIDATION.\nValidation error: ${cause.slice(0, 1200)}\nPrevious output (may be truncated):\n${(e.text ?? "").slice(0, 3000)}\n\nReturn a corrected response that satisfies the schema exactly. Respect every min/max length and enum.`,
        maxRetries: 1,
      });
      return { value: object, usedMock: false };
    } catch (err2) {
      console.error(`[llm] ${resolved.provider}/${resolved.modelId} repair failed, using mock:`, err2);
      return { value: call.mock(), usedMock: true };
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
    });
    return { text, usedMock: false };
  } catch (err) {
    console.error(`[llm] ${resolved.provider}/${resolved.modelId} chat failed, using mock:`, err);
    return { text: call.mock(), usedMock: true };
  }
}
