import { describe, expect, it } from "vitest";
import { langFor } from "../core.js";

describe("langFor", () => {
  it("uses TypeScript grammars for JavaScript-family PR sources", () => {
    expect(langFor("tool.mjs")).toBe("typescript");
    expect(langFor("tool.cjs")).toBe("typescript");
    expect(langFor("tool.js")).toBe("typescript");
    expect(langFor("view.jsx")).toBe("tsx");
    expect(langFor("module.mts")).toBe("typescript");
  });
});
