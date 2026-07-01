/**
 * claude-CLI-backed LLMClient — domain-card distillation via the `claude -p`
 * subscription CLI (no ANTHROPIC_API_KEY needed).
 *
 * Implements the injected `LLMClient` (domains/card.ts) by spawning the Claude
 * Code CLI in print mode (`claude -p --output-format json`). The distiller
 * system prompt is appended via `--append-system-prompt`; the per-card prompt
 * is fed on stdin (avoids arg-length / quoting limits on large reports). The
 * CLI emits a JSON ARRAY of message events; the terminal `{type:"result"}`
 * element carries `result` (the model text) plus token `usage`, which we
 * forward to the measurement transcript. (The model text may be wrapped in a
 * ```json fence; card.ts parses the first {...} block leniently.)
 *
 * NO FALLBACK: a missing CLI, a non-zero exit, an `is_error` envelope, or
 * unparseable output all THROW. A configuration deficiency must surface as an
 * error — it must never silently degrade to a stub card (RULE_CODE §7).
 *
 * SRP: this file only adapts the CLI to the LLMClient interface. Process
 * spawning uses an argv array (no shell), explicit stdio, and subscribes to the
 * child's error/close events (RULE_CODE §13).
 */

import { spawn } from "node:child_process";
import type { LLMClient } from "../domains/card.js";
import type { LlmUsage } from "../cache/transcript.js";
import { CARD_DISTILLER_SYSTEM_PROMPT } from "./anthropic-llm.js";
import { reportConcordiaCostOneShot } from "./concordia-cost.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_BIN = "claude";

export interface ClaudeCliLlmConfig {
  /** Model id passed to `--model`. Default claude-opus-4-8. */
  model?: string;
  /** CLI executable. Default `claude` (resolved on PATH). */
  bin?: string;
  /**
   * Usage sink — called once per CLI call with the token usage from the JSON
   * envelope. Optional; absent => no reporting.
   */
  onUsage?: (usage: LlmUsage) => void;
}

/** Build an LLMClient backed by the `claude -p` CLI. */
export function createClaudeCliLlm(config: ClaudeCliLlmConfig = {}): LLMClient {
  const model = config.model ?? DEFAULT_MODEL;
  const bin = config.bin ?? DEFAULT_BIN;

  return async (prompt: string): Promise<string> => {
    const startedAt = Date.now();
    const { stdout } = await runClaude(bin, model, prompt);
    const env = parseEnvelope(stdout);
    if (config.onUsage) config.onUsage(env.usage);
    void reportConcordiaCostOneShot({
      service: "anatomia",
      provider: "claude",
      command: `${bin} -p --output-format json`,
      model,
      cwd: process.cwd(),
      prompt,
      status: "ok",
      exit_code: 0,
      duration_ms: Date.now() - startedAt,
      input_tokens: env.usage.inputTokens,
      output_tokens: env.usage.outputTokens,
      total_tokens: env.usage.inputTokens + env.usage.outputTokens,
      metadata: {
        cacheReadTokens: env.usage.cacheReadTokens,
        cacheCreationTokens: env.usage.cacheCreationTokens,
      },
    });
    return env.result;
  };
}

/** Spawn `claude -p`, feed the prompt on stdin, collect stdout. Throws on failure. */
function runClaude(
  bin: string,
  model: string,
  prompt: string,
): Promise<{ stdout: string }> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--append-system-prompt",
    CARD_DISTILLER_SYSTEM_PROMPT,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (err) =>
      reject(new Error(`claude CLI failed to spawn (bin="${bin}"): ${err.message}`)),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout });
    });
    child.stdin.on("error", () => {
      /* child may close stdin early on its own error; the close handler reports it */
    });
    child.stdin.end(prompt, "utf8");
  });
}

/** The `--output-format json` envelope fields we read. */
interface ClaudeEnvelope {
  result: string;
  usage: LlmUsage;
}

/**
 * Parse and validate the CLI output. `--output-format json` emits a JSON array
 * of message events whose terminal `{type:"result"}` element holds the answer;
 * we also accept a bare result object for forward-compatibility. Throws on a
 * malformed payload or a non-success result (no fallback).
 */
function parseEnvelope(stdout: string): ClaudeEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  const result = findResultEvent(parsed);
  if (!result) {
    throw new Error(`claude CLI output has no {type:"result"} event: ${stdout.slice(0, 200)}`);
  }
  if (result["is_error"] === true || (result["subtype"] && result["subtype"] !== "success")) {
    throw new Error(`claude CLI reported a non-success result: ${stdout.slice(0, 200)}`);
  }
  const text = result["result"];
  if (typeof text !== "string") {
    throw new Error(`claude CLI result event missing string "result": ${stdout.slice(0, 200)}`);
  }
  return { result: text, usage: readUsage(result["usage"]) };
}

/** Locate the terminal `{type:"result"}` event in the array form (or the bare object). */
function findResultEvent(parsed: unknown): Record<string, unknown> | null {
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      const e = parsed[i] as Record<string, unknown>;
      if (e && e["type"] === "result") return e;
    }
    return null;
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (o["type"] === "result" || typeof o["result"] === "string") return o;
  }
  return null;
}

/** Map the envelope `usage` (snake_case, possibly absent) to our LlmUsage shape. */
function readUsage(usage: unknown): LlmUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u["input_tokens"]),
    outputTokens: num(u["output_tokens"]),
    cacheReadTokens: num(u["cache_read_input_tokens"]),
    cacheCreationTokens: num(u["cache_creation_input_tokens"]),
  };
}
