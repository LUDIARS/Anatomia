import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import type { GeneratedArtifact, GeneratedManifest } from "./types.js";

export interface GeneratedWriteRequest {
  generatedRoot: string;
  artifacts: GeneratedArtifact[];
  knowledgeHead: string | null;
  sourceRevision: string;
  sourceFingerprint: string;
  generatorSchema: number;
  projectionSchema: number;
  /** Re-read the canonical head immediately before replacing the generated set. */
  readCurrentKnowledgeHead?: () => Promise<string | null>;
  /** Re-read the authored/code source revision before replacing the generated set. */
  readCurrentSourceRevision?: () => Promise<string>;
}

export interface GeneratedWriteResult {
  manifest: GeneratedManifest;
  written: string[];
  unchanged: string[];
  removed: string[];
}

interface BeforeImage {
  path: string;
  content: Buffer | null;
}

function sha256(content: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function artifactBytes(content: string | Uint8Array): Buffer {
  return typeof content === "string"
    ? Buffer.from(content.replace(/\r\n?/g, "\n"), "utf8")
    : Buffer.from(content);
}

/**
 * Paths the writer owns itself. An artifact claiming one of them would be
 * clobbered by (or clobber) the lock/manifest bookkeeping — the lock file in
 * particular is unlinked in the `finally` block, silently deleting the artifact
 * the manifest still claims to own.
 */
const RESERVED_PATHS = /^(?:manifest\.json|\.anatomia\.lock|\.manifest-.*\.tmp)$/;

function safeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || RESERVED_PATHS.test(normalized) || isAbsolute(normalized)
    || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`generated artifact path is unsafe: ${path}`);
  }
  return normalized;
}

function targetPath(root: string, path: string): string {
  const target = resolve(root, safeRelativePath(path));
  const child = relative(resolve(root), target);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error(`generated artifact escapes root: ${path}`);
  return target;
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readPreviousManifest(path: string): Promise<GeneratedManifest | null> {
  const content = await readOptional(path);
  if (!content) return null;
  const manifest = JSON.parse(content.toString("utf8")) as GeneratedManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("generated ownership manifest has an unsupported schema");
  }
  return manifest;
}

async function restore(images: BeforeImage[]): Promise<void> {
  for (const image of [...images].reverse()) {
    if (image.content === null) await unlink(image.path).catch(() => undefined);
    else {
      await mkdir(dirname(image.path), { recursive: true });
      await writeFile(image.path, image.content);
    }
  }
}

export async function writeGeneratedArtifacts(request: GeneratedWriteRequest): Promise<GeneratedWriteResult> {
  const root = resolve(request.generatedRoot);
  const manifestPath = join(root, "manifest.json");
  await mkdir(root, { recursive: true });
  const lockPath = join(root, ".anatomia.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`generated root is locked: ${root}`);
    throw error;
  }

  const stage = join(dirname(root), `.anatomia-stage-${process.pid}-${randomUUID()}`);
  try {
    const artifacts = request.artifacts
      .map((artifact) => ({ ...artifact, path: safeRelativePath(artifact.path), bytes: artifactBytes(artifact.content) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
      throw new Error("generated artifact paths must be unique");
    }
    await mkdir(stage, { recursive: true });
    for (const artifact of artifacts) {
      const staged = targetPath(stage, artifact.path);
      await mkdir(dirname(staged), { recursive: true });
      await writeFile(staged, artifact.bytes);
    }

    const entries = artifacts.map((artifact) => ({
      path: artifact.path,
      contentHash: sha256(artifact.bytes),
      entityId: artifact.entityId,
    }));
    const outputFingerprint = sha256(canonicalJson(entries));
    const manifest: GeneratedManifest = {
      schemaVersion: 1,
      generatorSchema: request.generatorSchema,
      projectionSchema: request.projectionSchema,
      knowledgeHead: request.knowledgeHead,
      sourceRevision: request.sourceRevision,
      sourceFingerprint: request.sourceFingerprint,
      outputFingerprint,
      files: entries,
    };
    const previous = await readPreviousManifest(manifestPath);
    if (request.readCurrentKnowledgeHead
      && await request.readCurrentKnowledgeHead() !== request.knowledgeHead) {
      throw new Error("knowledge head changed while generated artifacts were staged");
    }
    if (request.readCurrentSourceRevision
      && await request.readCurrentSourceRevision() !== request.sourceRevision) {
      throw new Error("source revision changed while generated artifacts were staged");
    }

    const newPaths = new Set(entries.map((entry) => entry.path));
    const stalePaths = (previous?.files ?? [])
      .map((entry) => safeRelativePath(entry.path))
      .filter((path) => !newPaths.has(path));
    const affected = [manifestPath]
      .concat(artifacts.map((artifact) => targetPath(root, artifact.path)))
      .concat(stalePaths.map((path) => targetPath(root, path)));
    const before = await Promise.all([...new Set(affected)].map(async (path) => ({ path, content: await readOptional(path) })));

    const result: GeneratedWriteResult = { manifest, written: [], unchanged: [], removed: [] };
    try {
      const previousHashes = new Map((previous?.files ?? []).map((entry) => [entry.path, entry.contentHash]));
      for (const artifact of artifacts) {
        const target = targetPath(root, artifact.path);
        if (previousHashes.get(artifact.path) === sha256(artifact.bytes)
          && (await readOptional(target))?.equals(artifact.bytes)) {
          result.unchanged.push(artifact.path);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await rename(targetPath(stage, artifact.path), target);
        result.written.push(artifact.path);
      }
      for (const path of stalePaths) {
        const target = targetPath(root, path);
        if (await readOptional(target)) {
          await unlink(target);
          result.removed.push(path);
        }
      }
      const manifestBytes = Buffer.from(canonicalJson(manifest) + "\n", "utf8");
      const oldManifest = await readOptional(manifestPath);
      if (!oldManifest?.equals(manifestBytes)) {
        const temporaryManifest = join(root, `.manifest-${randomUUID()}.tmp`);
        await writeFile(temporaryManifest, manifestBytes);
        await rename(temporaryManifest, manifestPath);
      }
      return result;
    } catch (error) {
      await restore(before);
      throw error;
    }
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
