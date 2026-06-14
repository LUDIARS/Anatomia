/**
 * LinkStore — in-memory store for Links and SpecClauses.
 * Supports add/get/merge/serialize operations.
 */

import type { Link, SpecClause } from "../types.js";
import { mergeLinks } from "./harden.js";

export class LinkStore {
  private links: Link[] = [];
  private clauses: Map<string, SpecClause> = new Map();

  /** Add a single link (no deduplication). */
  add(link: Link): void {
    this.links.push(link);
  }

  /** Register a spec clause keyed by its id. */
  addClause(clause: SpecClause): void {
    this.clauses.set(clause.id, clause);
  }

  /** Return all stored links. */
  getLinks(): Link[] {
    return this.links;
  }

  /** Return all links whose `from` field matches the given value. */
  getLinksByFrom(from: string): Link[] {
    return this.links.filter((l) => l.from === from);
  }

  /** Return all links whose `to` field matches the given clause id. */
  getLinksByTo(to: string): Link[] {
    return this.links.filter((l) => l.to === to);
  }

  /** Look up a stored clause by id. */
  getClause(id: string): SpecClause | undefined {
    return this.clauses.get(id);
  }

  /**
   * Merge new links into the store, deduplicating against existing links.
   * The best link per (from, to) pair wins (explicit > structural > semantic,
   * then higher confidence).
   */
  merge(newLinks: Link[]): void {
    this.links = mergeLinks([...this.links, ...newLinks]);
  }

  /** Serialise the entire store to a plain object. */
  serialize(): { links: Link[]; clauses: SpecClause[] } {
    return {
      links: this.links,
      clauses: Array.from(this.clauses.values()),
    };
  }
}
