/**
 * Anthropic LLM adapter test (A-2). The SDK is mocked — no network — to verify
 * the adapter joins text content blocks and drops non-text blocks (thinking).
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
      })),
    };
  },
}));

import { createAnthropicLlm } from "../anthropic-llm.js";

describe("createAnthropicLlm", () => {
  it("concatenates text blocks and ignores non-text blocks", async () => {
    const llm = createAnthropicLlm({ apiKey: "sk-test", model: "claude-opus-4-8" });
    const out = await llm("Domain: combat");
    expect(out).toBe('{"summary":"S","rules":[],"specRefs":[],"complexity":"low"}');
    expect(JSON.parse(out)).toMatchObject({ summary: "S", complexity: "low" });
  });
});
