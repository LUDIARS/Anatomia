/**
 * scenesFromScreenGraph — detected UI screens become Scenes view seeds.
 */

import { describe, expect, it } from "vitest";
import type { ScreenGraph, ScreenNode } from "../screens/index.js";
import { scenesFromScreenGraph } from "./from-screens.js";

function screen(overrides: Partial<ScreenNode>): ScreenNode {
  return {
    name: "HomePage",
    file: "src/Home.tsx",
    line: 1,
    kind: "page",
    stack: "web",
    contains: [],
    navigatesTo: [],
    reason: "test",
    domains: [],
    ...overrides,
  };
}

function graph(screens: ScreenNode[]): ScreenGraph {
  return { screens, summary: { total: screens.length, byStack: {}, byKind: {}, edges: 0 } };
}

describe("scenesFromScreenGraph", () => {
  it("projects screens to scene refs and preserves their domain attribution", () => {
    const scenes = scenesFromScreenGraph(graph([
      screen({ name: "BattleScreen", route: "/battle", domains: ["ui", "combat", "ui"] }),
    ]));

    expect(scenes).toEqual([
      { id: "BattleScreen", label: "BattleScreen (/battle)", domains: ["combat", "ui"] },
    ]);
  });

  it("disambiguates duplicate screen names deterministically", () => {
    const scenes = scenesFromScreenGraph(graph([
      screen({ name: "SettingsView", file: "src/web/Settings.tsx" }),
      screen({ name: "SettingsView", file: "src/native/Settings.cpp", stack: "native" }),
    ]));

    expect(scenes.map((s) => s.id)).toEqual([
      "SettingsView@src/web/Settings.tsx",
      "SettingsView@src/native/Settings.cpp",
    ]);
  });
});
