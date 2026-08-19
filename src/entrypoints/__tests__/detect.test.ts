/**
 * src/entrypoints/__tests__/detect.test.ts — entry detection + folding.
 *
 * The primary fixtures are Anatomia's own shapes (the CLI's if-chain subcommand
 * dispatch and the web routes' `app.get/post`), because those are the first
 * things the feature has to recognise about the tool it ships in.
 */

import { describe, it, expect } from "vitest";
import { buildEntryPointManifest } from "../detect.js";
import { detectorInput, fileNode, fn, screen } from "./fixtures.js";

describe("cli-command detection", () => {
  it("recognises Anatomia's own if-chain subcommand dispatch", () => {
    const manifest = buildEntryPointManifest(detectorInput({
      sources: {
        "src/adapters/cli.ts": [
          "export async function runCli(args) {",
          '  if (args.subcommand === "project") {',
          "    return runProject(args);",
          "  }",
          '  if (args.subcommand === "scenes") {',
          "    return runScenes(args);",
          "  }",
          "}",
        ].join("\n"),
      },
      functions: [
        fn({ name: "runCli", path: "src/adapters/cli.ts", line: 0 }),
        fn({ name: "runProject", path: "src/adapters/project-cli.ts" }),
        fn({ name: "runScenes", path: "src/adapters/scenes-cli.ts" }),
      ],
    }));
    const names = manifest.entries.map((entry) => entry.symbol.name).sort();
    expect(names).toContain("runProject");
    expect(names).toContain("runScenes");
    const project = manifest.entries.find((entry) => entry.symbol.name === "runProject")!;
    expect(project.classes).toEqual(["cli-command"]);
    expect(project.detector).toEqual(["cli-command"]);
  });

  it("recognises a switch/case dispatch", () => {
    const manifest = buildEntryPointManifest(detectorInput({
      sources: {
        "src/cli.ts": 'switch (verb) {\n  case "add": {\n    return runAdd(args);\n  }\n}\n',
      },
      functions: [fn({ name: "runAdd", path: "src/commands/add.ts" })],
    }));
    expect(manifest.entries.map((entry) => entry.symbol.name)).toEqual(["runAdd"]);
  });
});

describe("http-route detection", () => {
  it("recognises Anatomia's own app.get/post route registrations", () => {
    const manifest = buildEntryPointManifest(detectorInput({
      sources: {
        "src/adapters/web/routes/projects.ts":
          'app.get("/api/projects", listProjects);\napp.post("/api/projects", addProject);\n',
      },
      functions: [
        fn({ name: "listProjects", path: "src/adapters/web/routes/projects.ts", line: 10 }),
        fn({ name: "addProject", path: "src/adapters/web/routes/projects.ts", line: 20 }),
      ],
    }));
    expect(manifest.entries.map((entry) => entry.symbol.name)).toEqual(["addProject", "listProjects"]);
    expect(manifest.entries.every((entry) => entry.classes.includes("http-route"))).toBe(true);
  });

  it("recognises a Next file route's exported verb handlers", () => {
    const manifest = buildEntryPointManifest(detectorInput({
      sources: {
        "app/api/users/route.ts": "export async function GET() {}\nexport async function POST() {}\n",
      },
      functions: [
        fn({ name: "GET", path: "app/api/users/route.ts", line: 0 }),
        fn({ name: "POST", path: "app/api/users/route.ts", line: 1 }),
      ],
    }));
    expect(manifest.entries.map((entry) => entry.symbol.name)).toEqual(["GET", "POST"]);
    expect(manifest.entries[0]!.reasons[0]).toContain("Next route file");
  });
});

describe("framework-lifecycle detection", () => {
  it("recognises a MonoBehaviour lifecycle callback and keeps its phase", () => {
    const update = fn({ name: "Update", path: "Assets/Player.cs", line: 4, enclosingType: "Player", params: [] });
    const player = {
      name: "Player",
      bases: ["MonoBehaviour"],
      filePath: "/repo/Assets/Player.cs",
      sourceRange: {
        start: { line: 0, column: 0 }, end: { line: 20, column: 0 }, filePath: "/repo/Assets/Player.cs",
      },
    };
    const manifest = buildEntryPointManifest(detectorInput({
      sources: { "Assets/Player.cs": "public class Player : MonoBehaviour { void Update() {} }\n" },
      functions: [update],
      files: [fileNode("Assets/Player.cs", [update], [player])],
      projectProfile: { kind: "unity", defaultGraphView: "class" },
    }));
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.classes).toEqual(["framework-lifecycle"]);
    expect(manifest.entries[0]!.phase).toBe("update");
  });
});

describe("test-source scope", () => {
  const sources = {
    "src/adapters/cli.ts": 'if (subcommand === "run") { return runIt(args); }\n',
    "src/__tests__/cli.test.ts": 'if (subcommand === "probe") { return runProbe(args); }\n',
  };
  const functions = [
    fn({ name: "runIt", path: "src/run.ts" }),
    fn({ name: "runProbe", path: "src/__tests__/cli.test.ts", line: 3 }),
  ];

  it("excludes test sources by default", () => {
    const manifest = buildEntryPointManifest(detectorInput({ sources, functions }));
    expect(manifest.entries.map((entry) => entry.symbol.name)).toEqual(["runIt"]);
  });

  it("includes them when includeTests is on", () => {
    const manifest = buildEntryPointManifest(detectorInput({
      sources, functions, config: { includeTests: true },
    }));
    expect(manifest.entries.map((entry) => entry.symbol.name).sort()).toEqual(["runIt", "runProbe"]);
  });
});

describe("folding and config", () => {
  it("folds one symbol hit by three detectors into a single entry", () => {
    const render = fn({ name: "HomeScreen", path: "src/screens/HomeScreen.tsx", line: 1 });
    const manifest = buildEntryPointManifest(detectorInput({
      sources: {
        "src/screens/HomeScreen.tsx": "// @anatomia-entry\nexport function HomeScreen() {}\n",
      },
      functions: [render],
      screens: [screen({ name: "HomeScreen", file: "src/screens/HomeScreen.tsx" })],
      config: {
        include: [{ symbol: "src/screens/HomeScreen.tsx#HomeScreen", class: "process" }],
      },
    }));
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.classes).toEqual(["explicit", "process", "screen"]);
    expect(manifest.entries[0]!.detector).toEqual(["explicit-annotation", "explicit-config", "screen"]);
  });

  it("drops an entry matched by an exclude rule", () => {
    const manifest = buildEntryPointManifest(detectorInput({
      sources: { "src/main.ts": "export function main() {}\n" },
      functions: [fn({ name: "main", path: "src/main.ts" })],
      config: { exclude: [{ pathGlob: "src/**" }] },
    }));
    expect(manifest.entries).toEqual([]);
    expect(manifest.diagnostics.map((d) => d.kind)).toEqual(["no-entry-detected"]);
  });

  it("emits no-entry-detected instead of a silent empty manifest", () => {
    const manifest = buildEntryPointManifest(detectorInput({ sources: {}, functions: [] }));
    expect(manifest.entries).toEqual([]);
    expect(manifest.diagnostics[0]!.kind).toBe("no-entry-detected");
  });

  it("does not leak one annotation onto the next nearby declaration", () => {
    const manifest = buildEntryPointManifest(detectorInput({
      sources: {
        "src/handlers.ts": [
          "// @anatomia-entry event-handler",
          "export function first() {}",
          "export function second() {}",
        ].join("\n"),
      },
      functions: [
        fn({ name: "first", path: "src/handlers.ts", line: 1 }),
        fn({ name: "second", path: "src/handlers.ts", line: 2 }),
      ],
    }));
    expect(manifest.entries.map((entry) => entry.symbol.name)).toEqual(["first"]);
  });

  it("is deterministic: the same input yields byte-identical JSON", () => {
    const spec = {
      sources: {
        "src/adapters/web/routes/a.ts": 'app.get("/a", handleA);\napp.post("/b", handleB);\n',
        "src/adapters/cli.ts": 'if (subcommand === "x") { return runX(args); }\n',
      },
      functions: [
        fn({ name: "handleA", path: "src/adapters/web/routes/a.ts", line: 5 }),
        fn({ name: "handleB", path: "src/adapters/web/routes/a.ts", line: 9 }),
        fn({ name: "runX", path: "src/x.ts" }),
      ],
    };
    const first = JSON.stringify(buildEntryPointManifest(detectorInput(spec)));
    const second = JSON.stringify(buildEntryPointManifest(detectorInput(spec)));
    expect(first).toBe(second);
  });
});

describe("event and timer detection", () => {
  it("recognises subscriptions and timers", () => {
    const manifest = buildEntryPointManifest(detectorInput({
      sources: {
        "src/bot.ts": 'client.on("messageCreate", onMessage);\nsetInterval(tick, 1000);\n',
      },
      functions: [
        fn({ name: "onMessage", path: "src/handlers.ts" }),
        fn({ name: "tick", path: "src/timers.ts" }),
      ],
    }));
    const byName = new Map(manifest.entries.map((entry) => [entry.symbol.name, entry]));
    expect(byName.get("onMessage")!.classes).toEqual(["event-handler"]);
    expect(byName.get("tick")!.classes).toEqual(["scheduled"]);
  });
});
