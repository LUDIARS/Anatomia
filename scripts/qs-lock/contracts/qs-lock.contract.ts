import { isDeepStrictEqual } from "node:util";

export default {
  post: (result: boolean, before: string, after: string): true | string => {
    if (!result) return true; // Rejected candidates are checked by the regression cases.
    const previous = JSON.parse(before);
    const updated = JSON.parse(after);
    const qs = updated.packages["node_modules/qs"];
    if (qs.version !== "6.16.2") return "qs fixed version missing";
    if (qs.resolved !== "https://registry.npmjs.org/qs/-/qs-6.16.2.tgz") return "unexpected archive";
    if (qs.integrity !== "sha512-VYdnB5S7/0IeXzBacUtwNAaM6d7Y/PgYnNC7bJCI6meqA/OgnsQbZMtVW8Dt2D1PHgbHGtYmhSoEIgvt7xZ2ZA==") return "unexpected integrity";
    previous.packages["node_modules/qs"] = { ...previous.packages["node_modules/qs"],
      version: qs.version, resolved: qs.resolved, integrity: qs.integrity };
    return isDeepStrictEqual(previous, updated) || "unrelated lock information changed";
  },
};
