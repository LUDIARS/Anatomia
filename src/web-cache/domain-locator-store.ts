import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainLocatorBuild, DomainLocatorCatalog, DomainLocatorShard } from "./domain-locator.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export class DomainLocatorError extends Error {
  constructor(public readonly code: "prepare-required" | "domain-not-found", message: string) { super(message); }
}

function root(cacheDir: string): string { return join(cacheDir, "domain-locator"); }
function shardKey(layer: string, id: string): string { return createHash("sha256").update(`${layer}\0${id}`).digest("hex").slice(0, 24) + ".json"; }
async function parseJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new DomainLocatorError("prepare-required", "domain locator is missing or corrupt; prepare the web cache again"); }
}
function isCatalog(value: unknown): value is DomainLocatorCatalog {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<DomainLocatorCatalog>;
  return row.version === 1 && typeof row.projectId === "string" && typeof row.preparedAt === "string"
    && typeof row.fingerprint === "string" && row.freshness === "unchecked"
    && Array.isArray(row.domains) && row.domains.every((domain) => domain && typeof domain.id === "string"
      && (domain.layer === "business" || domain.layer === "program") && typeof domain.name === "string"
      && Number.isSafeInteger(domain.functionCount) && typeof domain.shard === "string" && /^[a-f0-9]{24}\.json$/.test(domain.shard));
}
function isShard(value: unknown, domainId: string, count: number): value is DomainLocatorShard {
  if (!value || typeof value !== "object") return false;
  const shard = value as Partial<DomainLocatorShard>;
  return shard.id === domainId && Array.isArray(shard.functions) && shard.functions.length === count
    && shard.functions.every((row) => row && typeof row.anchor === "string" && typeof row.name === "string"
      && typeof row.path === "string" && Number.isSafeInteger(row.line)
      && (row.comment === null || typeof row.comment === "string")
      && Array.isArray(row.specRefs) && row.specRefs.every((ref) => typeof ref === "string"));
}

/** Publish one complete immutable generation, then swap its small active pointer. */
export async function writeDomainLocator(
  cacheDir: string, projectId: string, fingerprint: string, preparedAt: string, build: DomainLocatorBuild,
): Promise<void> {
  const dir = root(cacheDir);
  const generation = randomUUID();
  const target = join(dir, generation);
  await mkdir(target, { recursive: true });
  const domains = [];
  const identities = new Set<string>();
  for (const domain of build.domains) {
    const identity = `${domain.layer}\0${domain.id}`;
    if (identities.has(identity)) throw new Error(`duplicate domain locator identity: ${domain.layer}:${domain.id}`);
    identities.add(identity);
    const shard = shardKey(domain.layer, domain.id);
    const data: DomainLocatorShard = { id: domain.id, functions: domain.functions };
    await writeFile(join(target, shard), JSON.stringify(data), "utf8");
    domains.push({ id: domain.id, layer: domain.layer, name: domain.name, functionCount: domain.functionCount, shard });
  }
  const catalog: DomainLocatorCatalog = { version: 1, projectId, fingerprint, preparedAt, freshness: "unchecked", domains };
  await writeFile(join(target, "catalog.json"), JSON.stringify(catalog), "utf8");
  const pending = join(dir, `current-${generation}.json`);
  await writeFile(pending, JSON.stringify({ generation }), "utf8");
  await rename(pending, join(dir, "current.json"));
  // Keep the active generation and recent predecessors for in-flight readers.
  // Retention is best effort; cleanup never affects a completed publish.
  try {
    const generations = (await readdir(dir)).filter((name) => /^[0-9a-f-]{36}$/.test(name));
    const aged = await Promise.all(generations.map(async (name) => ({ name, time: (await stat(join(dir, name))).mtimeMs })));
    const protectedNames = new Set(aged.sort((a, b) => b.time - a.time).slice(0, 2).map((entry) => entry.name));
    protectedNames.add(generation);
    for (const entry of aged) if (!protectedNames.has(entry.name) && Date.now() - entry.time > 60 * 60_000) {
      await rm(join(dir, entry.name), { recursive: true });
    }
  } catch { /* A concurrent reader/writer may keep an older generation. */ }
}

async function readCatalog(cacheDir: string): Promise<{ catalog: DomainLocatorCatalog; dir: string }> {
  const pointer = await parseJson(join(root(cacheDir), "current.json"));
  const generation = (pointer as { generation?: unknown })?.generation;
  if (typeof generation !== "string" || !/^[0-9a-f-]{36}$/.test(generation))
    throw new DomainLocatorError("prepare-required", "invalid domain locator generation; prepare the web cache again");
  const dir = join(root(cacheDir), generation);
  const catalog = await parseJson(join(dir, "catalog.json"));
  if (!isCatalog(catalog)) throw new DomainLocatorError("prepare-required", "invalid domain locator catalog; prepare the web cache again");
  return { catalog, dir };
}

export async function listPreparedDomains(cacheDir: string): Promise<DomainLocatorCatalog> {
  return (await readCatalog(cacheDir)).catalog;
}

export async function listPreparedFunctions(cacheDir: string, domainId: string, limit = DEFAULT_LIMIT, offset = 0, layer?: "business" | "program", name?: string) {
  const { catalog, dir } = await readCatalog(cacheDir);
  const candidates = catalog.domains.filter((row) => row.id === domainId && (!layer || row.layer === layer));
  if (candidates.length > 1) throw new DomainLocatorError("domain-not-found", `ambiguous domain "${domainId}"; specify layer`);
  const domain = candidates[0];
  if (!domain) throw new DomainLocatorError("domain-not-found", `unknown domain "${domainId}"`);
  const data = await parseJson(join(dir, domain.shard));
  if (!isShard(data, domainId, domain.functionCount))
    throw new DomainLocatorError("prepare-required", "invalid domain locator shard; prepare the web cache again");
  const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const filtered = name ? data.functions.filter((row) => row.name.toLowerCase().includes(name.toLowerCase())) : data.functions;
  return { domain, preparedAt: catalog.preparedAt, fingerprint: catalog.fingerprint, freshness: catalog.freshness,
    total: filtered.length, offset: start, truncated: filtered.length > start + bounded, functions: filtered.slice(start, start + bounded) };
}

/** Supporting bottom-up path; bounded by one catalog and its prepared shards. */
export async function findPreparedFunction(cacheDir: string, anchor: string) {
  const { catalog, dir } = await readCatalog(cacheDir);
  const domains = new Map<string, { id: string; layer: "business" | "program" }>();
  const locations = new Map<string, DomainLocatorShard["functions"][number]>();
  for (const domain of catalog.domains) {
    const data = await parseJson(join(dir, domain.shard));
    if (!isShard(data, domain.id, domain.functionCount)) throw new DomainLocatorError("prepare-required", "invalid domain locator shard; prepare the web cache again");
    for (const row of data.functions) if (row.anchor === anchor) {
      domains.set(`${domain.layer}\0${domain.id}`, { id: domain.id, layer: domain.layer });
      const key = `${row.path}\0${row.line}`;
      const previous = locations.get(key);
      locations.set(key, previous ? { ...previous, specRefs: [...new Set([...previous.specRefs, ...row.specRefs])].sort(), comment: previous.comment ?? row.comment } : row);
    }
  }
  return { anchor, preparedAt: catalog.preparedAt, fingerprint: catalog.fingerprint, freshness: catalog.freshness,
    domains: [...domains.values()], functions: [...locations.values()] };
}
