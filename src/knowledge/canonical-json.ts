/** JSON encoding with recursively sorted object keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    // Map/Set/Date and class instances have no own enumerable data keys, so they
    // would encode as "{}" — two materially different states would then share a
    // transaction hash. This function feeds every integrity hash; fail loudly.
    const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
    if (prototype !== null && prototype !== Object.prototype) {
      throw new TypeError(`canonical JSON rejects non-plain object ${prototype.constructor?.name ?? "object"}`);
    }
    const object = value as Record<string, unknown>;
    const members = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}
