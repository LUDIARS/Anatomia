/**
 * Provider resolution (A-2) — pick concrete LLM + embedder from config/env.
 *
 * LLM backend selection (no silent fallback — RULE_CODE §7 / §9):
 *   - ANTHROPIC_API_KEY set        -> Anthropic SDK
 *   - else (default)               -> `claude -p` subscription CLI
 *   - ANATOMIA_LLM_BACKEND=stub    -> offline placeholder (EXPLICIT opt-in only;
 *                                     for hermetic tests / deliberately offline)
 * A configuration deficiency (e.g. backend=anthropic with no key) is a hard
 * error, never a quiet downgrade to the stub. The stub is chosen, not fallen
 * back into. Embedding still degrades gracefully (a hash embedder is a genuine
 * capability tier, like Vulkan->OpenGL, not a config-deficiency mask).
 *
 *   Embed  : ANATOMIA_EMBED_BASE_URL set -> OpenAI-compatible ; else hash embedder.
 *
 * Environment variables (secrets read from env, never committed):
 *   ANATOMIA_LLM_BACKEND       anthropic | claude-cli | stub (omit -> inferred)
 *   ANTHROPIC_API_KEY          Anthropic key (enables/selects the SDK backend)
 *   ANATOMIA_LLM_MODEL         model id (default claude-opus-4-8)
 *   ANATOMIA_CLAUDE_BIN        `claude` CLI path for the claude-cli backend
 *   ANATOMIA_EMBED_BASE_URL    OpenAI-compatible base URL incl. /v1
 *   ANATOMIA_EMBED_API_KEY     bearer key for the embeddings endpoint
 *   ANATOMIA_EMBED_MODEL       embeddings model id (default text-embedding-3-small)
 *   ANATOMIA_EMBED_DIM         hash-embedder dimension (default 256)
 *
 * SRP: configuration -> Providers. No analysis logic here.
 */

import { createAnthropicLlm } from "./anthropic-llm.js";
import { createClaudeCliLlm } from "./claude-cli-llm.js";
import { createOpenAiEmbedder } from "./openai-embedder.js";
import { createHashEmbedder } from "./hash-embedder.js";
import type { Providers, ProviderConfig } from "./types.js";
import type { LLMClient } from "../domains/card.js";
import type { LlmUsage } from "../cache/transcript.js";

/** Optional runtime hooks threaded into the resolved providers. */
export interface ProviderHooks {
  /** Called once per real LLM API call with its token usage (measurement). */
  onUsage?: (usage: LlmUsage) => void;
}

export type { Providers, ProviderConfig } from "./types.js";
export { createAnthropicLlm } from "./anthropic-llm.js";
export { createClaudeCliLlm } from "./claude-cli-llm.js";
export { createOpenAiEmbedder } from "./openai-embedder.js";
export { createHashEmbedder } from "./hash-embedder.js";

/** Resolved LLM backend kind. */
export type LlmBackend = "anthropic" | "claude-cli" | "stub";

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
    llmBackend: parseBackend(env["ANATOMIA_LLM_BACKEND"]),
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    llmModel: env["ANATOMIA_LLM_MODEL"] || undefined,
    claudeBin: env["ANATOMIA_CLAUDE_BIN"] || undefined,
    embedBaseUrl: env["ANATOMIA_EMBED_BASE_URL"] || undefined,
    embedApiKey: env["ANATOMIA_EMBED_API_KEY"] || undefined,
    embedModel: env["ANATOMIA_EMBED_MODEL"] || undefined,
    embedDim: dim !== undefined && Number.isFinite(dim) ? dim : undefined,
  };
}

/** Validate an explicit backend string from config/env; unknown values fail fast. */
function parseBackend(raw: string | undefined): ProviderConfig["llmBackend"] {
  if (!raw) return undefined;
  if (raw === "anthropic" || raw === "claude-cli" || raw === "stub") return raw;
  throw new Error(
    `ANATOMIA_LLM_BACKEND="${raw}" is not a valid backend (anthropic | claude-cli | stub).`,
  );
}

/**
 * Decide the LLM backend WITHOUT silent fallback: an explicit choice wins;
 * otherwise infer from the presence of an API key. "stub" is never inferred —
 * it must be asked for by name (RULE_CODE §7 / §9).
 */
function chooseBackend(config: ProviderConfig): LlmBackend {
  if (config.llmBackend) return config.llmBackend;
  return config.anthropicApiKey ? "anthropic" : "claude-cli";
}

/** Build the LLM client for the chosen backend, failing fast on missing prerequisites. */
function buildLlm(
  backend: LlmBackend,
  config: ProviderConfig,
  hooks: ProviderHooks | undefined,
  model: string,
): LLMClient {
  switch (backend) {
    case "anthropic":
      if (!config.anthropicApiKey) {
        throw new Error(
          'LLM backend "anthropic" requires ANTHROPIC_API_KEY. Set the key, or use ' +
            "ANATOMIA_LLM_BACKEND=claude-cli (subscription CLI) / =stub (offline tests).",
        );
      }
      return createAnthropicLlm({ apiKey: config.anthropicApiKey, model: config.llmModel, onUsage: hooks?.onUsage });
    case "claude-cli":
      return createClaudeCliLlm({ model, bin: config.claudeBin, onUsage: hooks?.onUsage });
    case "stub":
      return createStubLlm();
  }
}

/** Resolve a concrete LLM + embedder pair from config (defaults to env). */
export function resolveProviders(
  config: ProviderConfig = envConfig(),
  hooks?: ProviderHooks,
): Providers {
  const backend = chooseBackend(config);
  const llmModel = config.llmModel ?? DEFAULT_LLM_MODEL;
  const llm = buildLlm(backend, config, hooks, llmModel);
  const llmModelId = backend === "stub" ? "stub-llm" : llmModel;

  const embedReal = Boolean(config.embedBaseUrl);
  const embedModel = config.embedModel ?? DEFAULT_EMBED_MODEL;
  const embedDim = config.embedDim ?? DEFAULT_EMBED_DIM;
  const embed = embedReal
    ? createOpenAiEmbedder({ baseUrl: config.embedBaseUrl!, model: embedModel, apiKey: config.embedApiKey })
    : createHashEmbedder(embedDim);
  const embedModelId = embedReal ? embedModel : `hash-embedder-${embedDim}`;

  return {
    llm,
    embed,
    llmModelId,
    embedModelId,
    describe() {
      const llmDesc =
        backend === "anthropic"
          ? `anthropic(${llmModel})`
          : backend === "claude-cli"
            ? `claude-cli(${llmModel})`
            : "stub-llm";
      const embedDesc = embedReal
        ? `openai-compat(${embedModel} @ ${config.embedBaseUrl})`
        : `hash-embedder(dim=${embedDim})`;
      return `llm=${llmDesc}, embed=${embedDesc}`;
    },
  };
}
