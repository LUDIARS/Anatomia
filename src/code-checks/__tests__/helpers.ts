/**
 * Test helper: run the checks over one inline source and pick findings by rule.
 */
import { DEFAULT_CONFIG } from "../config.js";
import { runCodeChecks } from "../run.js";
import type { CodeCheckConfig, CodeCheckThresholds, CodeFinding } from "../types.js";

export async function findings(
  text: string,
  options: { file?: string; thresholds?: Partial<CodeCheckThresholds> } = {},
): Promise<CodeFinding[]> {
  const config: CodeCheckConfig = {
    ...DEFAULT_CONFIG,
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...options.thresholds },
  };
  const report = await runCodeChecks([{ file: options.file ?? "sample.cpp", text }], config);
  return [...report.findings];
}

export async function rulesOf(text: string, prefix: string, options?: Parameters<typeof findings>[1]): Promise<string[]> {
  return (await findings(text, options)).filter((f) => f.rule.startsWith(prefix)).map((f) => `${f.rule}@${f.line}`);
}
