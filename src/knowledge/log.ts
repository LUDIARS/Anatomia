import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import type {
  KnowledgeEdge,
  KnowledgeEdgeKind,
  KnowledgeNode,
  KnowledgeNodeKind,
  KnowledgeGraph,
  KnowledgeTransaction,
  KnowledgeTransactionDraft,
} from "./types.js";

const pendingWrites = new Map<string, Promise<void>>();

export class KnowledgeHeadConflictError extends Error {
  readonly expectedHead: string | null;
  readonly actualHead: string | null;
  readonly statusCode = 409;

  constructor(expectedHead: string | null, actualHead: string | null) {
    super(`knowledge head conflict: expected ${expectedHead ?? "<empty>"}, got ${actualHead ?? "<empty>"}`);
    this.name = "KnowledgeHeadConflictError";
    this.expectedHead = expectedHead;
    this.actualHead = actualHead;
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function transactionPayload(transaction: KnowledgeTransaction): Omit<KnowledgeTransaction, "transactionHash"> {
  const { transactionHash: _ignored, ...payload } = transaction;
  return payload;
}

export function materializeTransaction(
  draft: KnowledgeTransactionDraft,
  previousHead: string | null,
): KnowledgeTransaction {
  const partial = { schemaVersion: 1 as const, previousHead, ...draft };
  return { ...partial, transactionHash: digest(partial) };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function validateTransaction(value: unknown, line: number): KnowledgeTransaction {
  const transaction = requireRecord(value, `knowledge line ${line}`) as unknown as KnowledgeTransaction;
  if (transaction.schemaVersion !== 1) throw new Error(`knowledge line ${line} has unknown schema`);
  if (!transaction.transactionId || typeof transaction.transactionId !== "string") {
    throw new Error(`knowledge line ${line} has no transactionId`);
  }
  if (!Array.isArray(transaction.operations)) throw new Error(`knowledge line ${line} has no operations`);
  if (typeof transaction.transactionHash !== "string") throw new Error(`knowledge line ${line} has no hash`);
  return transaction;
}

const EDGE_ENDPOINTS: Record<KnowledgeEdgeKind, readonly [KnowledgeNodeKind, KnowledgeNodeKind]> = {
  "subdomain-of": ["domain", "domain"],
  "domain-owns-spec": ["domain", "spec-clause"],
  "domain-relates-spec": ["domain", "spec-clause"],
  "domain-owns-code": ["domain", "code-symbol"],
  "domain-uses-code": ["domain", "code-symbol"],
  "scene-contains": ["scene", "scene-element"],
  "subscene-of": ["scene", "scene"],
  "scene-transitions-to": ["scene", "scene"],
  "scene-has-entry": ["scene", "code-symbol"],
  "scene-activates-code": ["scene", "code-symbol"],
  "scene-activates-domain": ["scene", "domain"],
  "scene-relates-spec": ["scene", "spec-clause"],
  "scene-element-realized-by": ["scene-element", "code-symbol"],
};

function validateCardinality(edges: Iterable<KnowledgeEdge>): void {
  const oneParent = new Map<string, string>();
  const oneOwner = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind === "subdomain-of" || edge.kind === "subscene-of") {
      const key = `${edge.kind}:${edge.from}`;
      const previous = oneParent.get(key);
      if (previous && previous !== edge.to) throw new Error(`${edge.from} has multiple ${edge.kind} parents`);
      oneParent.set(key, edge.to);
    }
    if (edge.kind === "domain-owns-spec" || edge.kind === "domain-owns-code") {
      const key = `${edge.kind}:${edge.to}`;
      const previous = oneOwner.get(key);
      if (previous && previous !== edge.from) throw new Error(`${edge.to} has multiple semantic owners`);
      oneOwner.set(key, edge.from);
    }
  }
}

function validateAcyclic(edges: Iterable<KnowledgeEdge>, kind: "subdomain-of" | "subscene-of"): void {
  const parent = new Map<string, string>();
  for (const edge of edges) if (edge.kind === kind) parent.set(edge.from, edge.to);
  for (const start of parent.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (seen.has(current)) throw new Error(`${kind} cycle includes ${current}`);
      seen.add(current);
      current = parent.get(current);
    }
  }
}

export function validateKnowledgeGraph(state: Pick<KnowledgeGraph, "nodes" | "edges">): void {
  for (const edge of state.edges.values()) {
    const from = state.nodes.get(edge.from);
    const to = state.nodes.get(edge.to);
    if (!from || !to) throw new Error(`dangling edge ${edge.id}`);
    const endpoints = EDGE_ENDPOINTS[edge.kind];
    if (!endpoints || from.kind !== endpoints[0] || to.kind !== endpoints[1]) {
      throw new Error(`edge ${edge.id} has invalid endpoint kinds`);
    }
  }
  validateCardinality(state.edges.values());
  validateAcyclic(state.edges.values(), "subdomain-of");
  validateAcyclic(state.edges.values(), "subscene-of");
}

function applyTransaction(state: KnowledgeGraph, transaction: KnowledgeTransaction): void {
  for (const operation of transaction.operations) {
    if (operation.op === "upsert-node") state.nodes.set(operation.record.id, operation.record);
    else if (operation.op === "upsert-edge") state.edges.set(operation.record.id, operation.record);
    else if (operation.op === "remove-node") state.nodes.delete(operation.id);
    else if (operation.op === "remove-edge") state.edges.delete(operation.id);
    else if (operation.op === "replace-derived-set") {
      for (const [id, node] of state.nodes) {
        if (node.data?.derivedOwner === operation.owner) state.nodes.delete(id);
      }
      for (const [id, edge] of state.edges) {
        if (edge.evidence?.derivedOwner === operation.owner) state.edges.delete(id);
      }
      for (const node of operation.nodes) {
        state.nodes.set(node.id, { ...node, data: { ...node.data, derivedOwner: operation.owner } });
      }
      for (const edge of operation.edges) {
        state.edges.set(edge.id, { ...edge, evidence: { ...edge.evidence, derivedOwner: operation.owner } });
      }
    } else {
      throw new Error(`unknown knowledge operation ${(operation as { op?: unknown }).op}`);
    }
  }
}

export function replayKnowledgeLog(text: string): KnowledgeGraph {
  const state: KnowledgeGraph = {
    head: null,
    transactions: [],
    nodes: new Map<string, KnowledgeNode>(),
    edges: new Map<string, KnowledgeEdge>(),
  };
  if (text === "") return state;
  if (!text.endsWith("\n")) throw new Error("knowledge log must end with LF");
  if (text.includes("\r")) throw new Error("knowledge log must use LF line endings");
  const transactionIds = new Set<string>();
  const lines = text.slice(0, -1).split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) throw new Error(`knowledge line ${index + 1} is empty`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch (error) {
      throw new Error(`knowledge line ${index + 1} is invalid JSON`, { cause: error });
    }
    const transaction = validateTransaction(parsed, index + 1);
    if (lines[index] !== canonicalJson(transaction)) {
      throw new Error(`knowledge line ${index + 1} is not canonical JSON`);
    }
    if (transaction.previousHead !== state.head) throw new Error(`knowledge line ${index + 1} breaks hash chain`);
    if (transaction.transactionHash !== digest(transactionPayload(transaction))) {
      throw new Error(`knowledge line ${index + 1} has invalid transaction hash`);
    }
    if (transactionIds.has(transaction.transactionId)) throw new Error(`duplicate transaction ${transaction.transactionId}`);
    transactionIds.add(transaction.transactionId);
    applyTransaction(state, transaction);
    validateKnowledgeGraph(state);
    state.transactions.push(transaction);
    state.head = transaction.transactionHash;
  }
  return state;
}

async function withWriteQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
  const tail = previous.then(() => current, () => current);
  pendingWrites.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (pendingWrites.get(key) === tail) pendingWrites.delete(key);
  }
}

async function readExisting(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function writeKnowledgeTransaction(
  path: string,
  draft: KnowledgeTransactionDraft,
  expectedHead: string | null,
): Promise<KnowledgeTransaction> {
  return withWriteQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`knowledge log is locked: ${path}`);
      throw error;
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const before = await readExisting(path);
      const state = replayKnowledgeLog(before);
      if (state.head !== expectedHead) throw new KnowledgeHeadConflictError(expectedHead, state.head);
      const transaction = materializeTransaction(draft, state.head);
      const candidate = before + canonicalJson(transaction) + "\n";
      replayKnowledgeLog(candidate);
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(candidate, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      return transaction;
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  });
}
