/**
 * src/project/registry.ts — In-memory project registry.
 *
 * SRP: identity + CRUD over Project records. No persistence (that is store.ts),
 * no analysis (that is manager.ts). Deterministic ids let the same name/path
 * resolve to a stable id across restarts so a re-registered project rejoins its
 * persisted cache.
 *
 * Id derivation (deterministic, DESIGN: content-addressed identity):
 *   - if `input.id` given            → used verbatim (after slug normalization)
 *   - else if `input.name` non-empty → slug(name)
 *   - else                           → "p_" + sha256(rootPath)[0..12]
 * Collisions on a derived id fall back to a rootPath-hash suffix so two projects
 * named the same but rooted differently stay distinct.
 */

import { createHash } from "node:crypto";
import type { Project, ProjectInput, RegistrySnapshot } from "./types.js";

/** Lower-case, ascii-slug a name into an id-safe token. */
export function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "";
}

/** Short stable hash of a root path (forward-slashed for OS independence). */
export function rootHash(rootPath: string): string {
  const norm = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 12);
}

/** Derive the *base* id for an input (before collision handling). */
export function deriveId(input: ProjectInput): string {
  if (input.id && input.id.trim().length > 0) {
    return slug(input.id) || input.id.trim();
  }
  const fromName = slug(input.name ?? "");
  if (fromName.length > 0) return fromName;
  return "p_" + rootHash(input.rootPath);
}

export class ProjectRegistry {
  private readonly byId = new Map<string, Project>();
  private selectedId: string | null = null;

  /**
   * Register a project. Returns the stored record (with derived id + addedAt).
   * If a derived id already exists for a *different* rootPath, a rootPath-hash
   * suffix is appended to keep them distinct. Re-registering the same id+path
   * updates the existing record in place (idempotent).
   */
  add(input: ProjectInput): Project {
    let id = deriveId(input);
    const existing = this.byId.get(id);
    if (existing && normalizePath(existing.rootPath) !== normalizePath(input.rootPath)) {
      id = `${id}-${rootHash(input.rootPath)}`;
    }
    const project: Project = {
      id,
      name: input.name,
      rootPath: input.rootPath,
      languages: input.languages,
      ontologyDir: input.ontologyDir,
      specDirs: input.specDirs,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    this.byId.set(id, project);
    if (this.selectedId === null) this.selectedId = id;
    return project;
  }

  /**
   * Patch an existing project's settings in place (identity fields id/rootPath/
   * addedAt are not patchable). Returns the updated project, or undefined when
   * the id is unknown. Caller persists via saveRegistry.
   */
  update(
    id: string,
    patch: Partial<Pick<Project, "name" | "languages" | "ontologyDir" | "specDirs" | "specDirsAuto">>,
  ): Project | undefined {
    const existing = this.byId.get(id);
    if (!existing) return undefined;
    const updated: Project = { ...existing, ...patch };
    // An explicit undefined in the patch clears the field (exactOptionalPropertyTypes-safe).
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (patch[key] === undefined) delete (updated as unknown as Record<string, unknown>)[key];
    }
    this.byId.set(id, updated);
    return updated;
  }

  /** Get a project by id, or undefined. */
  get(id: string): Project | undefined {
    return this.byId.get(id);
  }

  /** True if an id is registered. */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** All projects, in insertion order. */
  list(): Project[] {
    return [...this.byId.values()];
  }

  /** Remove a project. Returns true if it existed. Clears selection if it was selected. */
  remove(id: string): boolean {
    const ok = this.byId.delete(id);
    if (ok && this.selectedId === id) {
      const next = this.byId.keys().next();
      this.selectedId = next.done ? null : next.value;
    }
    return ok;
  }

  /** The currently selected project id (or null). */
  get selected(): string | null {
    return this.selectedId;
  }

  /** Select a project. Throws if the id is unknown. */
  select(id: string): void {
    if (!this.byId.has(id)) {
      throw new Error(`ProjectRegistry.select: unknown project "${id}"`);
    }
    this.selectedId = id;
  }

  /** Serialize to a persistable snapshot. */
  toSnapshot(): RegistrySnapshot {
    return { version: 1, selected: this.selectedId, projects: this.list() };
  }

  /** Replace this registry's contents from a snapshot (used on load). */
  loadSnapshot(snap: RegistrySnapshot): void {
    this.byId.clear();
    for (const p of snap.projects) this.byId.set(p.id, p);
    this.selectedId =
      snap.selected && this.byId.has(snap.selected)
        ? snap.selected
        : this.byId.keys().next().value ?? null;
  }

  /** Build a registry directly from a snapshot. */
  static fromSnapshot(snap: RegistrySnapshot): ProjectRegistry {
    const reg = new ProjectRegistry();
    reg.loadSnapshot(snap);
    return reg;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}
