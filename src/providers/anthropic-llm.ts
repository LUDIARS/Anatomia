/**
 * Anthropic-backed LLMClient (A-2) — domain-card distillation.
 *
 * Implements the injected `LLMClient` (domains/card.ts) using the official
 * Anthropic SDK (`@anthropic-ai/sdk`). The model defaults to claude-opus-4-8;
 * an operator can pick a cheaper tier (e.g. claude-haiku-4-5) via config.
 *
 * Card distillation is a short JSON-shaped summarization task, so we omit
 * `thinking` (accepted on Opus 4.8 — the request simply runs without thinking)
 * for speed/cost, and pin the response to JSON via the system prompt. card.ts
 * already parses the JSON leniently.
 *
 * SRP: this file only adapts the SDK to the LLMClient interface. The SDK is
 * imported lazily so environments without a configured key (offline stub path)
 * never load it.
 */

import type { LLMClient } from "../domains/card.js";

export interface AnthropicLlmConfig {
  apiKey: string;
  /** Model id. Default claude-opus-4-8. */
  model?: string;
  /** Output cap. Default 1024 (a card is small). */
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 1024;

const SYSTEM_PROMPT =
  "You are Anatomia's domain-card distiller. You receive a domain detection " +
  "report (the domain name, its implementing functions, and any rule " +
  "violations) and must summarise the domain canonically. Respond with ONLY a " +
  'JSON object of the shape {"summary": string, "rules": string[], ' +
  '"specRefs": string[], "complexity": "low"|"medium"|"high"}. ' +
  "No prose, no markdown fences — JSON only.";

/** Build an LLMClient backed by the Anthropic Messages API. */
export function createAnthropicLlm(config: AnthropicLlmConfig): LLMClient {
  const model = config.model ?? DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Lazy, memoised client construction (avoids loading the SDK unless used).
  let clientPromise: Promise<{ messages: { create(body: unknown): Promise<{ content: { type: string; text?: string }[] }> } }> | null =
    null;
  const getClient = async () => {
    if (!clientPromise) {
      clientPromise = import("@anthropic-ai/sdk").then(
        (m) => new m.default({ apiKey: config.apiKey }),
      );
    }
    return clientPromise;
  };

  return async (prompt: string): Promise<string> => {
    const client = await getClient();
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });
    return res.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  };
}
