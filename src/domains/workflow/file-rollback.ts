/** Capture and restore exact file contents around a multi-file workflow write. */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface FileBeforeImage {
  path: string;
  content: Buffer | null;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function capture(path: string): Promise<FileBeforeImage> {
  try {
    return { path, content: await readFile(path) };
  } catch (error) {
    if (isMissingFile(error)) return { path, content: null };
    throw error;
  }
}

async function restore(image: FileBeforeImage): Promise<void> {
  if (image.content === null) {
    try {
      await unlink(image.path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return;
  }
  await mkdir(dirname(image.path), { recursive: true });
  await writeFile(image.path, image.content);
}

export class FileRollbackError extends Error {
  readonly operationError: unknown;
  readonly restoreErrors: readonly unknown[];

  constructor(operationError: unknown, restoreErrors: readonly unknown[]) {
    super(`workflow write failed and ${restoreErrors.length} before image(s) could not be restored`);
    this.name = "FileRollbackError";
    this.operationError = operationError;
    this.restoreErrors = restoreErrors;
  }
}

/**
 * Run a write while retaining before images for every possible target. If the
 * write fails, all targets are restored in reverse order before the error is
 * rethrown.
 */
export async function withFileRollback<T>(
  paths: readonly string[],
  write: () => Promise<T>,
): Promise<T> {
  const uniquePaths = [...new Set(paths)];
  const beforeImages = await Promise.all(uniquePaths.map(capture));
  try {
    return await write();
  } catch (operationError) {
    const restoreErrors: unknown[] = [];
    for (const image of [...beforeImages].reverse()) {
      try {
        await restore(image);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length > 0) {
      throw new FileRollbackError(operationError, restoreErrors);
    }
    throw operationError;
  }
}
