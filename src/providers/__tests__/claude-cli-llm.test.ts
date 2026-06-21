/**
 * claude-cli LLMClient tests — the NO-FALLBACK contract.
 *
 * A spawn failure (e.g. the CLI is not installed) must REJECT, never resolve to
 * a stub card. Configuration deficiency surfaces as an error (RULE_CODE §7/§9).
 * We avoid invoking a real `claude` binary by pointing at a name that cannot
 * resolve on PATH, which makes the child emit an ENOENT 'error' event.
 */

import { describe, it, expect } from "vitest";
import { createClaudeCliLlm } from "../claude-cli-llm.js";

describe("createClaudeCliLlm", () => {
  it("throws (does not fall back to a stub) when the CLI cannot be spawned", async () => {
    const llm = createClaudeCliLlm({ bin: "anatomia-no-such-claude-binary-xyz" });
    await expect(llm("Domain: combat\nImplementing functions (0):")).rejects.toThrow(
      /claude CLI failed to spawn/,
    );
  });
});
