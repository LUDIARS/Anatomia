/**
 * Provider tests (A-2): hash embedder determinism + similarity, OpenAI-compatible
 * embedder request/response shaping, Anthropic LLM adapter (SDK mocked), and
 * resolveProviders fallback/selection logic.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHashEmbedder } from "../hash-embedder.js";
import { createOpenAiEmbedder } from "../openai-embedder.js";
import { resolveProviders, envConfig } from "../index.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("hash embedder", () => {
  it("is deterministic and fixed-dimension", async () => {
    const embed = createHashEmbedder(64);
    const [a] = await embed(["apply damage to target"]);
    const [b] = await embed(["apply damage to target"]);
    expect(a).toEqual(b);
    expect(a!.length).toBe(64);
  });

  it("identical text → cosine 1, disjoint tokens → lower similarity", async () => {
    const embed = createHashEmbedder(256);
    const [same1, same2] = await embed(["heal the player", "heal the player"]);
    expect(cosine(same1!, same2!)).toBeCloseTo(1, 6);

    const [x, y] = await embed(["heal player health", "zzz qqq www vvv"]);
    expect(cosine(x!, y!)).toBeLessThan(cosine(same1!, same2!));
  });

  it("empty input → empty output", async () => {
    const embed = createHashEmbedder();
    expect(await embed([])).toEqual([]);
  });
});

describe("OpenAI-compatible embedder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to <base>/embeddings and parses data[].embedding by index", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://host/v1/embeddings");
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("m");
      expect(body.input).toEqual(["a", "b"]);
      // Return out-of-order to prove index honouring.
      return new Response(
        JSON.stringify({ data: [{ embedding: [2], index: 1 }, { embedding: [1], index: 0 }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const embed = createOpenAiEmbedder({ baseUrl: "http://host/v1/", model: "m" });
    const out = await embed(["a", "b"]);
    expect(out).toEqual([[1], [2]]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends a bearer header when apiKey is set", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["authorization"]).toBe("Bearer secret");
      return new Response(JSON.stringify({ data: [{ embedding: [1], index: 0 }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const embed = createOpenAiEmbedder({ baseUrl: "http://host/v1", model: "m", apiKey: "secret" });
    await embed(["x"]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500, statusText: "err" })),
    );
    const embed = createOpenAiEmbedder({ baseUrl: "http://host/v1", model: "m" });
    await expect(embed(["x"])).rejects.toThrow(/embeddings request failed: 500/);
  });
});

describe("resolveProviders", () => {
  it('defaults the LLM to the claude-cli backend when no key is configured (no stub fallback)', () => {
    const p = resolveProviders({});
    expect(p.describe()).toContain("claude-cli(");
    expect(p.describe()).not.toContain("stub-llm");
    expect(p.describe()).toContain("hash-embedder");
  });

  it('uses the stub LLM only when explicitly requested (backend="stub")', async () => {
    const p = resolveProviders({ llmBackend: "stub" });
    expect(p.describe()).toContain("stub-llm");
    expect(p.llmModelId).toBe("stub-llm");
    // The stub LLM still returns valid, parseable card JSON.
    const json = JSON.parse(await p.llm("Domain: combat\nImplementing functions (1):"));
    expect(json).toMatchObject({ summary: expect.any(String), complexity: "medium" });
    expect(String(json.summary)).toContain("combat");
  });

  it('backend="anthropic" without a key fails fast (configuration deficiency is an error)', () => {
    expect(() => resolveProviders({ llmBackend: "anthropic" })).toThrow(/requires ANTHROPIC_API_KEY/);
  });

  it("selects the real backends when configured (without invoking them)", () => {
    const p = resolveProviders({
      anthropicApiKey: "sk-test",
      llmModel: "claude-haiku-4-5",
      embedBaseUrl: "http://localhost:11434/v1",
      embedModel: "nomic-embed-text",
    });
    const d = p.describe();
    expect(d).toContain("anthropic(claude-haiku-4-5)");
    expect(d).toContain("openai-compat(nomic-embed-text @ http://localhost:11434/v1)");
  });

  it("envConfig reads the documented variables", () => {
    const prev = { ...process.env };
    try {
      process.env["ANTHROPIC_API_KEY"] = "k";
      process.env["ANATOMIA_EMBED_BASE_URL"] = "http://e/v1";
      process.env["ANATOMIA_EMBED_DIM"] = "128";
      const cfg = envConfig();
      expect(cfg.anthropicApiKey).toBe("k");
      expect(cfg.embedBaseUrl).toBe("http://e/v1");
      expect(cfg.embedDim).toBe(128);
    } finally {
      process.env = prev;
    }
  });
});
