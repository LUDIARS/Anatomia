import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

export interface KnowledgeProposal<T = Record<string, unknown>> {
  id: string;
  expectedHead: string | null;
  sourceRevision: string;
  value: T;
}

/** Unapproved proposals live outside the append-only approved knowledge log. */
export class KnowledgeProposalStore {
  constructor(private readonly root: string) {}

  private path(id: string): string {
    if (!/^[A-Za-z0-9._~-]+$/.test(id)) throw new Error("proposal id is not path-safe");
    return join(this.root, `${id}.json`);
  }

  async put<T>(proposal: KnowledgeProposal<T>): Promise<void> {
    const path = this.path(proposal.id);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, canonicalJson(proposal) + "\n", "utf8");
    await rename(temporary, path);
  }

  async get<T>(id: string): Promise<KnowledgeProposal<T> | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as KnowledgeProposal<T>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
