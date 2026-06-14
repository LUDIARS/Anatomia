/**
 * T39 — Build strategy configuration.
 */
import { generateCppHeader } from './inject-cpp.js';
import { generateCSharpStub } from './inject-csharp.js';

export interface BuildStrategyConfig {
  enabled: boolean;
  cppFlag?: string;
  csharpFlag?: string;
}

export function createBuildStrategy(config: BuildStrategyConfig): {
  config: Required<BuildStrategyConfig>;
  generateCppHeader(): string;
  generateCSharpStub(): string;
} {
  const resolved: Required<BuildStrategyConfig> = {
    enabled: config.enabled,
    cppFlag: config.cppFlag ?? 'ANATOMIA_MEASUREMENT_BUILD',
    csharpFlag: config.csharpFlag ?? 'ANATOMIA_MEASUREMENT_BUILD',
  };

  return {
    config: resolved,
    generateCppHeader(): string {
      return generateCppHeader(resolved.enabled);
    },
    generateCSharpStub(): string {
      return generateCSharpStub(resolved.enabled);
    },
  };
}
