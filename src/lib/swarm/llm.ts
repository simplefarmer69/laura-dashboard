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
    console.error(`[llm] ${resolved.provider}/${resolved.modelId} failed, using mock:`, err);
    return { value: call.mock(), usedMock: true };
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
