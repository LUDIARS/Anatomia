import { isDeepStrictEqual } from "node:util";
import { contract } from '../../src/adapters/web/contracts/runtime.ts'; /* augur-inject:import:e0734189 */
import augurContract_f542407f from './contracts/qs-lock.contract.ts'; /* augur-inject:contract-predicate:f8f497e9 */

// Only the two existing caret ranges are accepted; no general semver parser is needed.
export function verifyQsLock(before: string, after: string): boolean {
  const previous = JSON.parse(before);
  const updated = JSON.parse(after);
  const qs = updated.packages["node_modules/qs"];
  if (previous.packages["node_modules/qs"].version !== "6.15.3") return false;
  if (updated.packages["node_modules/body-parser"].dependencies.qs !== "^6.15.2") return false;
  if (updated.packages["node_modules/express"].dependencies.qs !== "^6.14.0") return false;
  if (qs.version !== "6.16.2"
    || qs.resolved !== "https://registry.npmjs.org/qs/-/qs-6.16.2.tgz"
    || qs.integrity !== "sha512-VYdnB5S7/0IeXzBacUtwNAaM6d7Y/PgYnNC7bJCI6meqA/OgnsQbZMtVW8Dt2D1PHgbHGtYmhSoEIgvt7xZ2ZA==") return false;
  previous.packages["node_modules/qs"] = {
    ...previous.packages["node_modules/qs"],
    version: qs.version, resolved: qs.resolved, integrity: qs.integrity,
  };
  return isDeepStrictEqual(previous, updated);
}
// @ts-expect-error augur-inject
verifyQsLock = contract(verifyQsLock, { ...augurContract_f542407f, contractId: 'C-1', mode: 'enforce', sample: 1, where: 'verify.ts:8', rule: 'contract-wrap', id: 'f542407f' }); /* augur-inject:contract-wrap:f542407f */
