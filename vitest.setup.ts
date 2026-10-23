/**
 * Keep every git the tests spawn free of the caller's hooks.
 *
 * Tests init throw-away repos and commit, branch and add worktrees in them. A
 * Concordia/Lictor session injects `core.hooksPath` through `GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (and ~/.gitconfig may set one too);
 * those hooks then fire on each fixture commit and push tests past their
 * timeout. Replacing the injected entries with one that points `core.hooksPath`
 * at a directory that never exists makes the suite independent of the host.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

for (const name of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/i.test(name)) delete process.env[name];
}
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
process.env.GIT_CONFIG_VALUE_0 = join(tmpdir(), "anatomia-test-no-git-hooks");
