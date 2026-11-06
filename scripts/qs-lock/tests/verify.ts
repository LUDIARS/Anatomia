import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyQsLock } from "../verify.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// Keep the comparison reproducible after main incorporates this update.
const base = process.argv[2] ?? "c4b8eb8";
const before = execFileSync("git", ["show", `${base}:package-lock.json`], { cwd: root, encoding: "utf8" });
const after = readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8");
assert.equal(verifyQsLock(before, before), false, "old vulnerable lock must be rejected");
assert.equal(verifyQsLock(before, after), true, "only the requested qs metadata may change");
type Lock = { packages: Record<string, { version: string; integrity: string; dependencies: Record<string, string> }> };
for (const mutate of [
  (lock: Lock): void => { lock.packages["node_modules/qs"].integrity = "invalid"; },
  (lock: Lock): void => { lock.packages["node_modules/body-parser"].dependencies.qs = "^7.0.0"; },
  (lock: Lock): void => { lock.packages["node_modules/express"].version = "0.0.0"; },
  (lock: Lock): void => { lock.packages["node_modules/qs"].dependencies["side-channel"] = "^2.0.0"; },
]) {
  const candidate = JSON.parse(after);
  mutate(candidate);
  assert.equal(verifyQsLock(before, JSON.stringify(candidate)), false, "unrelated or invalid changes must be rejected");
}
process.stdout.write("qs lock verification: 6 checks passed\n");
