/**
 * Anthropic LLM adapter test (A-2). The SDK is mocked — no network — to verify
 * the adapter joins text content blocks and drops non-text blocks (thinking),
 * and that onUsage receives the normalized token usage (A-3 measurement).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn(async () => ({
        content: [
          { type: "text", text: '{"summary":"' },
          { type: "thinking", thinking: "internal — must be ignored" },
          { type: "text", text: 'S","rules":[],"specRefs":[],"complexity":"low"}' },
        ],
        usage: {
          input_tokens: 123,
          output_tokens: 45,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: null,
        },
      })),
    };
  },
}));

import { createAnthropicLlm } from "../anthropic-llm.js";
import type { LlmUsage } from "../../cache/transcript.js";

describe("createAnthropicLlm", () => {
  it("concatenates text blocks and ignores non-text blocks", async () => {
    const llm = createAnthropicLlm({ apiKey: "sk-test", model: "claude-opus-4-8" });
    const out = await llm("Domain: combat");
    expect(out).toBe('{"summary":"S","rules":[],"specRefs":[],"complexity":"low"}');
    expect(JSON.parse(out)).toMatchObject({ summary: "S", complexity: "low" });
  });

  it("reports normalized token usage via onUsage (null -> 0)", async () => {
    const seen: LlmUsage[] = [];
    const llm = createAnthropicLlm({
      apiKey: "sk-test",
      model: "claude-opus-4-8",
      onUsage: (u) => seen.push(u),
    });
    await llm("Domain: combat");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 100,
      cacheCreationTokens: 0, // null normalized to 0
    });
  });
});
