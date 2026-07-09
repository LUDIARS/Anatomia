import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDomainOrganization,
  applyDomainOrganizationEdits,
  buildDomainOrganization,
  pathHintToAnatomiaDir,
} from "./index.js";

function design() {
  return buildDomainOrganization({
    project: "memoria",
    serviceName: "Memoria",
    serviceDescription: "Users record work logs.",
    specs: [{ title: "Worklog Capture", text: "# Worklog Capture\n- Users save a note in src/worklog/capture.ts." }],
    uxAnswers: [
      { questionId: "service:actor", answer: "Maintainers" },
      { questionId: "service:success", answer: "The note is visible." },
      { questionId: "worklog-capture:domain-boundary", answer: "Save and list work notes." },
      { questionId: "worklog-capture:domain-success", answer: "The saved note can be found." },
    ],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("domain organization", () => {
  it("builds a deterministic domain organization draft", () => {
    const draft = design();
    expect(draft.project).toBe("memoria");
    expect(draft.domains[0]).toMatchObject({
      name: "Worklog Capture",
      slug: "worklog-capture",
    });
    expect(draft.machineConfiguration.anatomia.domainDefs[0]?.name).toBe("worklog-capture");
  });

  it("applies a domain organization to the canonical taxonomy", async () => {
    const repo = await mkdtemp(join(tmpdir(), "anatomia-domain-organize-"));
    try {
      const edited = applyDomainOrganizationEdits(design(), {
        domains: [
          {
            match: "worklog-capture",
            pathHints: ["(^|/)src/worklog(/|$)", "(^|/)app/features/worklog"],
            nameHints: ["(Worklog|Capture)"],
          },
        ],
      });

      const report = await applyDomainOrganization(repo, "memoria", edited);
      expect(report.domains).toEqual([{ name: "worklog-capture", action: "created" }]);
      expect(report.paths.map((item) => item.path)).toEqual(["src/worklog", "app/features/worklog"]);
      expect(report.names).toEqual([
        { domain: "worklog-capture", module: "worklog-capture", pattern: "(Worklog|Capture)", action: "added" },
      ]);

      const tax = JSON.parse(await readFile(join(repo, "spec", "data", "memoria.taxonomy.json"), "utf8"));
      const module = tax.domains[0].modules[0];
      expect(module.paths).toHaveLength(2);
      expect(module.names).toEqual(["(Worklog|Capture)"]);

      const dropped = applyDomainOrganizationEdits(edited, {
        domains: [{ match: "worklog-capture", drop: true }],
      });
      const removed = await applyDomainOrganization(repo, "memoria", dropped, {
        removeDomains: ["worklog-capture"],
      });
      expect(removed.removedDomains).toEqual(["worklog-capture"]);

      const afterDrop = JSON.parse(await readFile(join(repo, "spec", "data", "memoria.taxonomy.json"), "utf8"));
      expect(afterDrop.domains.some((domain: { name: string }) => domain.name === "worklog-capture")).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("pathHintToAnatomiaDir", () => {
  it("converts regex path hints to taxonomy dirs", () => {
    expect(pathHintToAnatomiaDir("(^|/)src/worklog-capture(/|$)")).toBe("src/worklog-capture");
    expect(pathHintToAnatomiaDir("(^|/)app/features/worklog")).toBe("app/features/worklog");
    expect(pathHintToAnatomiaDir("(Worklog|Capture)")).toBeNull();
  });
});
