import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { withFileRollback } from "../../domains/workflow/file-rollback.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import { inventoryLegacyKnowledge, legacyInventoryFingerprint } from "./inventory.js";
import { planLegacyKnowledgeMigration } from "./plan.js";
import type { Project } from "../../project/types.js";
import type { SceneManifest } from "../scene/types.js";
import type { LegacyAnnotationWrite, LegacyMigrationApplyRequest, LegacyMigrationApplyResult } from "./types.js";

// @implements SPEC-knowledge-adapter-migration

async function loadKnowledgeGraph(path: string) {
  try { return replayKnowledgeLog(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return replayKnowledgeLog("");
    throw error;
  }
}

async function currentText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveWritePath(writeRoot: string, relativePath: string): string {
  const root = resolve(writeRoot);
  const path = resolve(root, relativePath);
  const child = relative(root, path);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`legacy migration path escapes knowledge write root: ${relativePath}`);
  }
  return path;
}

async function rejectSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("legacy migration refuses symbolic link target");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function validateAnnotations(writes: LegacyAnnotationWrite[], targets: string[]): Promise<void> {
  for (let index = 0; index < writes.length; index++) {
    const annotation = writes[index]!;
    const target = targets[index]!;
    const current = await currentText(target);
    if (current !== null && current !== annotation.content) {
      throw new Error(`legacy migration annotation conflict: ${annotation.path}`);
    }
  }
}

async function prepareWriteTargets(targets: string[]): Promise<void> {
  for (const target of targets) {
    await rejectSymbolicLink(target);
    await mkdir(dirname(target), { recursive: true });
    if (await realpath(dirname(target)) !== resolve(dirname(target))) {
      throw new Error("legacy migration refuses symbolic link directory");
    }
  }
}

async function writeAnnotations(writes: LegacyAnnotationWrite[], targets: string[]): Promise<void> {
  for (let index = 0; index < writes.length; index++) {
    await writeFile(targets[index]!, writes[index]!.content, { encoding: "utf8", flag: "wx" });
  }
}

export async function applyLegacyKnowledgeMigration(input: {
  project: Project;
  request: LegacyMigrationApplyRequest;
  knowledgeLogPath: string;
  sceneManifest: SceneManifest | null;
  sceneManifestStaleReasons?: string[];
  writeRoot: string;
}): Promise<LegacyMigrationApplyResult> {
  const { project, request, knowledgeLogPath, sceneManifest, sceneManifestStaleReasons, writeRoot } = input;
  if (!request.confirmApply) throw new Error("legacy migration requires confirmApply=true after dry-run review");
  const plan = await planLegacyKnowledgeMigration({
    project,
    state: await loadKnowledgeGraph(knowledgeLogPath),
    sceneManifest,
    sceneManifestStaleReasons,
    writeRoot,
  });
  if (!plan.canApply || plan.conflicts.length > 0) throw new Error("legacy migration has unresolved conflicts");
  if (plan.sourceFingerprint !== request.expectedSourceFingerprint) throw new Error("legacy migration source changed after dry-run");
  if (plan.expectedHead !== request.expectedHead) throw new Error("legacy migration knowledge head conflict");
  const freshFingerprint = legacyInventoryFingerprint((await inventoryLegacyKnowledge(project)).artifacts);
  if (freshFingerprint !== request.expectedSourceFingerprint || freshFingerprint !== plan.sourceFingerprint) {
    throw new Error("legacy migration source changed after dry-run");
  }
  const annotationTargets = plan.annotationWrites.map((write) => resolveWritePath(writeRoot, write.path));
  await validateAnnotations(plan.annotationWrites, annotationTargets);
  const targets = [knowledgeLogPath, ...annotationTargets];
  await prepareWriteTargets(targets);
  return withFileRollback(targets, async () => {
    await writeAnnotations(plan.annotationWrites, annotationTargets);
    const transaction = await writeKnowledgeTransaction(
      knowledgeLogPath,
      plan.transactionDraft,
      plan.expectedHead,
    );
    return { transaction, annotationPaths: plan.annotationWrites.map((write) => write.path), originalsRetained: true as const };
  });
}
