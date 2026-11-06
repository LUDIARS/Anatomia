import { describe, expect, it } from "vitest";
import { runCodeCheckCli } from "../code-check-cli.js";

describe("anatomia code-check argument handling", () => {
  it("rejects unknown flags with exit 2 and the usage line", async () => {
    const result = await runCodeCheckCli(["--depth", "3"], "/repo");
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/unknown flag --depth/);
    expect(result.output).toMatch(/usage: anatomia code-check/);
  });

  it("rejects an unknown --fail-on level", async () => {
    const result = await runCodeCheckCli(["--fail-on", "fatal"], "/repo");
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/--fail-on must be/);
  });

  it("rejects a flag missing its value", async () => {
    const result = await runCodeCheckCli(["--repo"], "/repo");
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/--repo needs a value/);
  });
});
