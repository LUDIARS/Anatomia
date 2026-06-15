/**
 * OpenAI-compatible embedder (A-2) — duplication gate + semantic linker.
 *
 * Implements the injected `EmbeddingClient` (spec/semantic.ts) against any
 * server speaking the OpenAI `/v1/embeddings` shape: OpenAI itself, a local
 * Ollama serving (`http://127.0.0.1:11434/v1`), Voyage's compat endpoint, etc.
 * Anthropic has no embeddings product, so embeddings are intentionally a
 * separate, swappable backend.
 *
 * Uses the global `fetch` (Node 18+); no SDK dependency.
 *
 * SRP: HTTP request/response shaping for one embeddings call.
 */

import type { EmbeddingClient } from "../spec/semantic.js";

export interface OpenAiEmbedderConfig {
  /** Base URL up to and including `/v1` (e.g. http://127.0.0.1:11434/v1). */
  baseUrl: string;
  /** Embeddings model id (e.g. text-embedding-3-small, nomic-embed-text). */
  model: string;
  /** Bearer key. Omit for keyless local servers. */
  apiKey?: string;
}

interface EmbeddingsResponse {
  data?: { embedding: number[]; index?: number }[];
}

/** Build an EmbeddingClient backed by an OpenAI-compatible embeddings endpoint. */
export function createOpenAiEmbedder(config: OpenAiEmbedderConfig): EmbeddingClient {
  const url = config.baseUrl.replace(/\/+$/, "") + "/embeddings";

  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.model, input: texts }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `embeddings request failed: ${resp.status} ${resp.statusText} ${body.slice(0, 200)}`,
      );
    }

    const json = (await resp.json()) as EmbeddingsResponse;
    const data = json.data ?? [];

    // Honour the per-item `index` field; fall back to response order.
    const out: number[][] = new Array<number[]>(texts.length);
    for (let i = 0; i < data.length; i++) {
      const d = data[i]!;
      const idx = typeof d.index === "number" ? d.index : i;
      out[idx] = d.embedding;
    }
    return out;
  };
}
