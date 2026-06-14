/**
 * src/adapters/cli.ts — T31: CLI gate adapter.
 *
 * Subcommands:
 *   verify  — run the 5-gate verify pipeline; exit 1 if any block gate fails
 *   context — assemble a ContextBundle; exit 0
 *   where   — resolve landing points; exit 0
 *
 * SRP: CLI arg parsing + output formatting only. Analysis via core.ts.
 */

import { readFile } from "node:fs/promises";
import {
  analyze,
  buildContextBundle,
  buildVerdict,
  getImpactRadius,
} from "../core.js";
import { resolveLanding } from "../supply/landing.js";
import type { Verdict, GateResult } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliArgs {
  subcommand: "verify" | "context" | "where";
  repoPath: string;
  /** For verify: path to diff file, or "-" to read stdin. */
  diff?: string;
  /** For context/where. */
  task?: string;
  /** --json flag: output raw JSON without human summary. */
  json?: boolean;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];

  const subcommand = args.shift();
  if (subcommand !== "verify" && subcommand !== "context" && subcommand !== "where") {
    throw new Error(
      `Unknown subcommand "${subcommand ?? ""}". Expected: verify | context | where`,
    );
  }

  let repoPath = process.cwd();
  let diff: string | undefined;
  let task: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--repo" || flag === "-r") {
      repoPath = args[++i] ?? repoPath;
    } else if (flag === "--diff" || flag === "-d") {
      diff = args[++i];
    } else if (flag === "--task" || flag === "-t") {
      task = args[++i];
    } else if (flag === "--json" || flag === "-j") {
      json = true;
    }
  }

  return { subcommand, repoPath, diff, task, json };
}

// ---------------------------------------------------------------------------
// Human summary for verify
// ---------------------------------------------------------------------------

function formatVerdict(verdict: Verdict): string {
  const lines: string[] = [];
  lines.push(verdict.pass ? "PASS" : "FAIL");
  for (const gate of verdict.gates) {
    const status = gate.pass ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${gate.gate}${gate.suggestion ? ` — ${gate.suggestion}` : ""}`);
  }
  if (verdict.suggestion) {
    lines.push("");
    lines.push(verdict.suggestion);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

export async function runCli(
  args: CliArgs,
): Promise<{ exitCode: number; output: string }> {
  const ctx = await analyze(args.repoPath);

  if (args.subcommand === "verify") {
    // Read diff source
    let diffSource = "";
    const diffArg = args.diff ?? "-";
    if (diffArg === "-") {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      diffSource = Buffer.concat(chunks).toString("utf8");
    } else {
      diffSource = await readFile(diffArg, "utf8");
    }

    const verdict = await buildVerdict(ctx, diffSource);
    const exitCode = verdict.pass ? 0 : 1;

    if (args.json) {
      return { exitCode, output: JSON.stringify(verdict, null, 2) };
    }
    return { exitCode, output: formatVerdict(verdict) };
  }

  if (args.subcommand === "context") {
    const task = args.task ?? "analyze";
    const bundle = await buildContextBundle(ctx, { task });

    return { exitCode: 0, output: JSON.stringify(bundle, null, 2) };
  }

  if (args.subcommand === "where") {
    const task = args.task ?? "analyze";
    const stubDetector = async () => ["general"];
    const stubLayerRules = { layerFor: () => null };
    const stubSiblings = async () => [];
    const landings = await resolveLanding(
      { description: task },
      stubDetector,
      stubLayerRules,
      stubSiblings,
    );

    return { exitCode: 0, output: JSON.stringify({ landings }, null, 2) };
  }

  // Should never reach here due to parseArgs validation.
  return { exitCode: 1, output: "Unknown subcommand" };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`anatomia: ${msg}\n`);
    process.exit(1);
  }

  const { exitCode, output } = await runCli(args);
  process.stdout.write(output + "\n");
  process.exit(exitCode);
}
