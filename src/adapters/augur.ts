/**
 * src/adapters/augur.ts -- Augur plan bridge (CLI transport).
 *
 * Augur ships as a daemon-less CLI: there is no Augur service and no port
 * (Augur `spec/plan/daemonless-cli.md`). Anatomia already assembles the whole
 * `CreatePlanRequest`, so it hands that request to `augur plan --request -` on
 * stdin and reads the `PlanResponse` back on stdout. Neither the request nor the
 * response shape changed when the transport did.
 *
 * The runner is injectable so tests stub the transport rather than a URL.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Where the Augur checkout lives. A path, because there is nothing to reach. */
const AUGUR_DIR_ENV = "ANATOMIA_AUGUR_DIR";
const DEFAULT_AUGUR_DIR = "../Augur";
const PLAN_TIMEOUT_MS = 10 * 60_000;

export interface AugurPlanResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export type AugurRunner = (cliPath: string, request: unknown) => Promise<AugurPlanResult>;

export class AugurUnavailableError extends Error {
  constructor(
    message: string,
    readonly augurDir: string,
  ) {
    super(message);
    this.name = "AugurUnavailableError";
  }
}

export class AugurPlanFailedError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "AugurPlanFailedError";
  }
}

export function resolveAugurDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[AUGUR_DIR_ENV]?.trim();
  return resolve(configured !== undefined && configured.length > 0 ? configured : DEFAULT_AUGUR_DIR);
}

export async function resolveAugurCli(augurDir: string): Promise<string> {
  const cliPath = join(augurDir, "bin", "augur.mjs");
  try {
    await access(cliPath);
  } catch {
    throw new AugurUnavailableError(
      `Augur CLI not found at ${cliPath}; set ${AUGUR_DIR_ENV} to the Augur checkout`,
      augurDir,
    );
  }
  return cliPath;
}

/**
 * Spawns the CLI with `process.execPath` and no shell: the argv is
 * Anatomia-owned and must not be re-parsed by a shell, and the caller may have no
 * `augur` on PATH.
 */
export const spawnAugur: AugurRunner = (cliPath, request) =>
  new Promise<AugurPlanResult>((resolveResult) => {
    const child = spawn(process.execPath, [cliPath, "plan", "--request", "-", "--json"], {
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: AugurPlanResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout, stderr: `${stderr}\nAugur plan timed out`, exitCode: null });
    }, PLAN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      finish({ ok: false, stdout, stderr: error.message, exitCode: null });
    });
    child.on("close", (code: number | null) => {
      finish({ ok: code === 0, stdout, stderr, exitCode: code });
    });
    // The child can close stdin before the whole request is written — it exits
    // early on a usage error, or never reads stdin at all. That arrives as EPIPE
    // on a stream with no `error` listener, i.e. an unhandled error event that
    // would take the whole server down. The exit code already decides the
    // outcome, so the write failure is recorded and left to it.
    child.stdin.on("error", (error: Error) => {
      stderr += `\nfailed to send the plan request to Augur: ${error.message}`;
    });
    child.stdin.end(JSON.stringify(request), "utf8");
  });

/**
 * Runs one plan. Augur exits 1 for a usage/validation error and 2 for an internal
 * one; both surface with the message Augur wrote to stderr, which is the same
 * text the HTTP 400 envelope used to carry.
 */
export async function requestAugurPlan(
  request: unknown,
  options: { env?: NodeJS.ProcessEnv; run?: AugurRunner } = {},
): Promise<Record<string, unknown>> {
  // The checkout is located only to spawn the binary. An injected runner brings
  // its own transport, so requiring a checkout it will never execute would make
  // the bridge untestable without one.
  const run = options.run;
  const cliPath = run === undefined
    ? await resolveAugurCli(resolveAugurDir(options.env))
    : "";
  const result = await (run ?? spawnAugur)(cliPath, request);
  if (!result.ok) {
    throw new AugurPlanFailedError(
      "Augur plan request failed",
      result.stderr.trim() || result.stdout.trim() || "no output",
      result.exitCode,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw notAPlanResponse(result);
  }
  // `null`, a bare number and an array all parse, so the object check is not
  // redundant with the catch: the caller indexes the payload, and doing that to
  // a non-object would throw out of the route as an unhandled 500 instead of the
  // 502 that describes what actually happened.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw notAPlanResponse(result);
  }
  return parsed as Record<string, unknown>;
}

function notAPlanResponse(result: AugurPlanResult): AugurPlanFailedError {
  return new AugurPlanFailedError(
    "Augur returned a response that is not JSON",
    result.stdout.slice(0, 500),
    result.exitCode,
  );
}
