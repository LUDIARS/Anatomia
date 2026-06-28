/**
 * Provider types (A-2) — the production wiring contract.
 *
 * Anatomia's analysis layers take their LLM + embedder as *injected* interfaces
 * (domains/card.ts `LLMClient`, spec/semantic.ts `EmbeddingClient`) so the core
 * never hardcodes an API. This module bundles those two into a `Providers`
 * object and resolves a concrete pair from configuration / environment.
 *
 * SRP: types + config shape only. Concrete clients live in their own files;
 * resolution lives in index.ts.
 */

import type { LLMClient } from "../domains/card.js";
import type { EmbeddingClient } from "../spec/semantic.js";

export type { LLMClient, EmbeddingClient };

/** A resolved LLM + embedder pair handed to verify / card distillation. */
export interface Providers {
  /** Domain-card distiller (prompt -> completion text). */
  llm: LLMClient;
  /** Text embedder for the duplication gate + semantic linker. */
  embed: EmbeddingClient;
  /**
   * Resolved LLM model id (e.g. "claude-opus-4-8", or "stub-llm" when offline).
   * Folded into the shared cache key so cards/labels from different models stay
   * distinct in a persistent store.
   */
  llmModelId: string;
  /**
   * Resolved embed model id (e.g. "text-embedding-3-small", or
   * "hash-embedder-256" offline). Folded into the embedding cache key so vectors
   * from different embedders never collide in a shared store.
   */
  embedModelId: string;
  /** One-line human-readable description of what is wired (diagnostics). */
  describe(): string;
}

/**
 * Provider configuration. Every field is optional; `resolveProviders`
 * (index.ts) falls back to deterministic offline implementations when a real
 * backend is not configured, so the engine always has *something* wired.
 *
 * Secrets (API keys) are read from the environment, never committed.
 */
export interface ProviderConfig {
  /**
   * LLM backend selection. When omitted it is inferred: `anthropicApiKey` set
   * -> "anthropic", else -> "claude-cli" (the subscription CLI). "stub" is the
   * offline placeholder and must be requested EXPLICITLY — it is never an
   * automatic fallback for a missing key (RULE_CODE §7 / §9).
   */
  llmBackend?: "anthropic" | "claude-cli" | "stub";
  /** Anthropic API key. Required only when the backend resolves to "anthropic". */
  anthropicApiKey?: string;
  /** Model id for card distillation (Anthropic SDK or claude CLI). Default claude-opus-4-8. */
  llmModel?: string;
  /** `claude` CLI executable for the "claude-cli" backend. Default resolves on PATH. */
  claudeBin?: string;
  /** OpenAI-compatible embeddings base URL (e.g. local Ollama `/v1`). Absent -> hash embedder. */
  embedBaseUrl?: string;
  /** Bearer key for the embeddings endpoint (omit for keyless local servers). */
  embedApiKey?: string;
  /** Embeddings model id. Default text-embedding-3-small. */
  embedModel?: string;
  /** Dimension for the offline hash embedder fallback. Default 256. */
  embedDim?: number;
}
