import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseOkfContent } from "./okf-parser.js";

const FRONTMATTER = `---
type: feature
title: Combat rules
service: game
x-anatomia:
  kind: specification
  id: spec:game/combat-rules
  domain-refs:
    - domain:game/combat
  symbol-refs:
    - code:game/resolve
---`;

describe("precise OKF parser", () => {
  it("preserves semantic units, ranges, modality, refs, and explicit ids", () => {
    const file = join("C:/repo/spec/feature", "combat.md");
    const parsed = parseOkfContent(`${FRONTMATTER}
# Rules
- [id: resolve-hit] Must call \`Combat.resolve\`.
- Damage application is 禁止 when invulnerable.

| Mode | Requirement |
| --- | --- |
| strict | should reject unknown damage |

Hit point :: Remaining combat health.

\`\`\`cpp
Combat::resolve(hit);
\`\`\`
`, file);
    expect(parsed.route).toBe("authored-spec");
    expect(parsed.explicitDocumentId).toBe(true);
    expect(parsed.clauses.map((clause) => clause.unitKind)).toEqual([
      "list-item", "list-item", "table-row", "definition", "code-reference",
    ]);
    expect(parsed.clauses[0]).toMatchObject({
      id: "spec:game/combat-rules#resolve-hit",
      explicitId: true,
      modality: "must",
      domainRefs: ["domain:game/combat"],
      codeReferences: ["Combat.resolve"],
    });
    expect(parsed.clauses[1].modality).toBe("must-not");
    expect(parsed.clauses[2].modality).toBe("should");
    expect(parsed.clauses.every((clause) => clause.sourceLines!.start > 0)).toBe(true);
  });

  it("keeps structural identities through body edits and explicit identities through label edits", () => {
    const file = "C:/repo/spec/feature/x.md";
    const first = parseOkfContent(`${FRONTMATTER}\n# Old label\nA body.\n`, file);
    const bodyEdit = parseOkfContent(`${FRONTMATTER}\n# Old label\nA changed body.\n`, file);
    expect(bodyEdit.clauses[0].id).toBe(first.clauses[0].id);
    expect(bodyEdit.clauses[0].revisionHash).not.toBe(first.clauses[0].revisionHash);

    const explicitA = parseOkfContent(`${FRONTMATTER}\n# Old label\n[id: stable] body\n`, file);
    const explicitB = parseOkfContent(`${FRONTMATTER}\n# New label\n[id: stable] body\n`, file);
    expect(explicitA.clauses[0].id).toBe(explicitB.clauses[0].id);
  });

  it("excludes generated documents and fails closed in typed authoring roots", () => {
    const generated = parseOkfContent(`${FRONTMATTER.replace("kind: specification", "kind: scene\n  generated: true")}\n# Scene\nbody`,
      "C:/repo/spec/other.md");
    expect(generated.route).toBe("generated");
    expect(generated.clauses).toEqual([]);

    expect(() => parseOkfContent(`${FRONTMATTER}\n# Wrong\nbody`, "C:/repo/spec/data/domains/wrong.md", {
      domainRoot: "C:/repo/spec/data/domains",
    })).toThrow(/kind: domain/);
  });

  it("parses foreign Markdown instead of aborting the surrounding analysis run", () => {
    const file = "C:/repo/docs/foreign.md";
    // A leading "---" thematic break, not an unterminated OKF frontmatter.
    const rule = parseOkfContent("---\n\n# Notes\nbody text\n", file);
    expect(rule.route).toBe("authored-spec");
    expect(rule.clauses.map((clause) => clause.text)).toContain("body text");

    // A non-AIFormat `type` is only an error for documents opting into routing.
    const foreignType = parseOkfContent("---\ntype: post\n---\n# Post\nbody\n", file);
    expect(foreignType.profile.type).toBeUndefined();
    expect(foreignType.clauses).toHaveLength(1);
    expect(() => parseOkfContent("---\ntype: post\nx-anatomia:\n  kind: specification\n---\n# P\nb\n", file))
      .toThrow(/unsupported AIFormat type/);

    // An unclosed fence closes at EOF rather than dropping the whole document.
    const fence = parseOkfContent("# Snippet\n```ts\nconst x = 1;\n", file);
    expect(fence.clauses.at(-1)).toMatchObject({ unitKind: "code-reference" });
  });

  it("accepts a projectId derived from a repository directory name", () => {
    const parsed = parseOkfContent("# Heading\nbody\n", "C:/repo/Ars Anatomia/spec/x.md", {
      projectId: "Ars Anatomia",
    });
    expect(parsed.documentId).toMatch(/^spec:ars-anatomia\//);
  });
});
