import { describe, it, expect } from "vitest";
import { resolveModel } from "@ludiars/one-shot";
import { resolveProviders } from "../index.js";

describe("shared one-shot model selection", () => {
  it("reports the common Opus default without invoking the CLI", () => {
    expect(resolveProviders({ llmBackend: "claude-cli" }).llmModelId).toBe(resolveModel("opus", "claude"));
  });
  it("retains an explicit model pin", () => {
    expect(resolveProviders({ llmBackend: "claude-cli", llmModel: "claude-opus-4-8" }).llmModelId).toBe("claude-opus-4-8");
  });
});
