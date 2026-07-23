/** Serialize domain workflow mutations for one repository-scoped Gate marker. */

import { resolve } from "node:path";

const pendingByScope = new Map<string, Promise<void>>();

function workflowScopeKey(repoRoot: string, _ontologyDir: string): string {
  // Gate A state is stored once per repository, so different ontologyDir values
  // for the same repo must still share a queue and cannot write the marker together.
  const key = resolve(repoRoot);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

/**
 * Run one mutation after every earlier mutation for the same project and
 * ontology directory. The queue promise never contains the task result, so a
 * rejected task cannot poison later callers.
 */
export async function withDomainWorkflowLock<T>(
  repoRoot: string,
  ontologyDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = workflowScopeKey(repoRoot, ontologyDir);
  const previous = pendingByScope.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(() => current, () => current);
  pendingByScope.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (pendingByScope.get(key) === tail) pendingByScope.delete(key);
  }
}
