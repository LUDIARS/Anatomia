import { describe, expect, it } from "vitest";
import {
  invalidRegexParams,
  isValidRegexSource,
  regexParamEntries,
  regexSourceProblem,
} from "./regex-source.js";

describe("regexSourceProblem", () => {
  it("accepts patterns the JS engine can compile", () => {
    expect(regexSourceProblem("[Aa]uth")).toBeNull();
    expect(regexSourceProblem("/server/src/auth/")).toBeNull();
    expect(regexSourceProblem("jwt|paseto")).toBeNull();
    expect(isValidRegexSource(".*")).toBe(true);
  });

  it("rejects Python style inline flags and says how to fix them", () => {
    const problem = regexSourceProblem("(?i)log|logger");

    expect(problem).not.toBeNull();
    expect(problem).toContain("(?i)");
    expect(problem).toContain("[Aa]");
    expect(isValidRegexSource("(?i)log|logger")).toBe(false);
  });

  it("rejects other malformed sources without the inline-flag hint", () => {
    const problem = regexSourceProblem("[unclosed");

    expect(problem).not.toBeNull();
    expect(problem).not.toContain("インラインフラグ");
  });
});

describe("regexParamEntries", () => {
  it("selects string params named *Pattern only", () => {
    expect(
      regexParamEntries({
        targetPattern: "[Aa]uth",
        pathPattern: "/src/",
        by: "name",
        maxFanOut: 3,
        pattern: "not-suffix-match",
      }),
    ).toEqual([
      ["targetPattern", "[Aa]uth"],
      ["pathPattern", "/src/"],
    ]);
  });

  it("treats missing params as nothing to check", () => {
    expect(regexParamEntries(undefined)).toEqual([]);
  });
});

describe("invalidRegexParams", () => {
  it("reports every broken pattern with its key", () => {
    const invalid = invalidRegexParams({
      targetPattern: "(?i)auth",
      pathPattern: "/src/",
      namePattern: "[unclosed",
    });

    expect(invalid.map((entry) => entry.key)).toEqual(["targetPattern", "namePattern"]);
    expect(invalid[0]?.pattern).toBe("(?i)auth");
  });

  it("is empty for a healthy rule", () => {
    expect(invalidRegexParams({ targetPattern: "[Ss]ecret", by: "name" })).toEqual([]);
  });
});
