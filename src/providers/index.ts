/**
 * Provider resolution (A-2) — pick concrete LLM + embedder from config/env.
 *
 * Resolution is graceful: a real backend is used when configured, otherwise a
 * deterministic offline implementation keeps the engine running (the engine
 * always has *something* wired, never a no-op).
 *
 *   LLM    : ANTHROPIC_API_KEY set -> Anthropic SDK ; else offline stub.
 *   Embed  : ANATOMIA_EMBED_BASE_URL set -> OpenAI-compatible ; else hash embedder.
 *
 * Environment variables (secrets read from env, never committed):
 *   ANTHROPIC_API_KEY          Anthropic key (enables the real distiller)
 *   ANATOMIA_LLM_MODEL         model id (default claude-opus-4-8)
 *   ANATOMIA_EMBED_BASE_URL    OpenAI-compatible base URL incl. /v1
 *   ANATOMIA_EMBED_API_KEY     bearer key for the embeddings endpoint
 *   ANATOMIA_EMBED_MODEL       embeddings model id (default text-embedding-3-small)
 *   ANATOMIA_EMBED_DIM         hash-embedder dimension (default 256)
 *
 * SRP: configuration -> Providers. No analysis logic here.
 */

import { createAnthropicLlm } from "./anthropic-llm.js";
import { createOpenAiEmbedder } from "./openai-embedder.js";
import { createHashEmbedder } from "./hash-embedder.js";
import type { Providers, ProviderConfig } from "./types.js";
import type { LLMClient } from "../domains/card.js";

export type { Providers, ProviderConfig } from "./types.js";
export { createAnthropicLlm } from "./anthropic-llm.js";
export { createOpenAiEmbedder } from "./openai-embedder.js";
export { createHashEmbedder } from "./hash-embedder.js";

const DEFAULT_LLM_MODEL = "claude-opus-4-8";
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const DEFAULT_EMBED_DIM = 256;

/**
 * Offline LLM stub: derives a minimal, valid card JSON from the prompt without
 * any API call. Keeps domain cards populated when no key is configured; it is a
 * placeholder, not a real distiller.
 */
function createStubLlm(): LLMClient {
  return async (prompt: string): Promise<string> => {
    const domainLine = prompt.split(/\r?\n/).find((l) => l.startsWith("Domain:"));
    const domain = domainLine ? domainLine.replace(/^Domain:\s*/, "").trim() : "domain";
    return JSON.stringify({
      summary: `(${domain || "domain"}) offline stub card — set ANTHROPIC_API_KEY for a real summary.`,
      rules: [],
      specRefs: [],
      complexity: "medium",
    });
  };
}

/** Read provider configuration from process.env. */
export function envConfig(): ProviderConfig {
  const env = process.env;
  const dimRaw = env["ANATOMIA_EMBED_DIM"];
  const dim = dimRaw ? Number(dimRaw) : undefined;
  return {
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    llmModel: env["ANATOMIA_LLM_MODEL"] || undefined,
    embedBaseUrl: env["ANATOMIA_EMBED_BASE_URL"] || undefined,
    embedApiKey: env["ANATOMIA_EMBED_API_KEY"] || undefined,
    embedModel: env["ANATOMIA_EMBED_MODEL"] || undefined,
    embedDim: dim !== undefined && Number.isFinite(dim) ? dim : undefined,
  };
}

/** Resolve a concrete LLM + embedder pair from config (defaults to env). */
export function resolveProviders(config: ProviderConfig = envConfig()): Providers {
  const llmReal = Boolean(config.anthropicApiKey);
  const llm: LLMClient = llmReal
    ? createAnthropicLlm({ apiKey: config.anthropicApiKey!, model: config.llmModel })
    : createStubLlm();

  const embedReal = Boolean(config.embedBaseUrl);
  const embedModel = config.embedModel ?? DEFAULT_EMBED_MODEL;
  const embedDim = config.embedDim ?? DEFAULT_EMBED_DIM;
  const embed = embedReal
    ? createOpenAiEmbedder({ baseUrl: config.embedBaseUrl!, model: embedModel, apiKey: config.embedApiKey })
    : createHashEmbedder(embedDim);

  const llmModelId = llmReal ? (config.llmModel ?? DEFAULT_LLM_MODEL) : "stub-llm";

  return {
    llm,
    embed,
    llmModelId,
    describe() {
      const llmDesc = llmReal ? `anthropic(${config.llmModel ?? DEFAULT_LLM_MODEL})` : "stub-llm";
      const embedDesc = embedReal
        ? `openai-compat(${embedModel} @ ${config.embedBaseUrl})`
        : `hash-embedder(dim=${embedDim})`;
      return `llm=${llmDesc}, embed=${embedDesc}`;
    },
  };
}
