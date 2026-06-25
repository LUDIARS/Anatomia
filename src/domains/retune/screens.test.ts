/**
 * retune/screens — screen graph → taxonomy DomainPlan + prompt summary.
 */
import { describe, it, expect } from "vitest";
import { screensToDomainPlan, summarizeScreens, SCREEN_DOMAIN_NAME } from "./screens.js";
import type { ScreenGraph, ScreenNode } from "../../screens/index.js";

function screen(over: Partial<ScreenNode>): ScreenNode {
  return {
    name: "X",
    file: "src/x.tsx",
    line: 1,
    kind: "view",
    stack: "web",
    contains: [],
    navigatesTo: [],
    reason: "",
    domains: [],
    ...over,
  };
}

function graph(screens: ScreenNode[]): ScreenGraph {
  return { screens, summary: { total: screens.length, byStack: {}, byKind: {}, edges: 0 } };
}

describe("screensToDomainPlan", () => {
  it("groups file-backed screens by stack×kind into modules owning their files", () => {
    const g = graph([
      screen({ name: "HomePage", kind: "page", file: "src/pages/Home.tsx" }),
      screen({ name: "AboutPage", kind: "page", file: "src/pages/About.tsx" }),
      screen({ name: "ProfileView", kind: "view", file: "src/components/ProfileView.tsx" }),
    ]);
    const plan = screensToDomainPlan(g)!;
    expect(plan.name).toBe(SCREEN_DOMAIN_NAME);
    const pageMod = plan.modules.find((m) => m.name === "screens-web-page")!;
    expect(pageMod.paths).toEqual(["src/pages/About\\.tsx$", "src/pages/Home\\.tsx$"]);
    expect(plan.modules.map((m) => m.name).sort()).toEqual(["screens-web-page", "screens-web-view"]);
  });

  it("returns null when no screen owns a file (scene-only graph)", () => {
    const g = graph([screen({ name: "MainScene", kind: "scene", stack: "unity", file: "" })]);
    expect(screensToDomainPlan(g)).toBeNull();
  });
});

describe("summarizeScreens", () => {
  it("renders compact lines with stack/kind/route and edges", () => {
    const g = graph([
      screen({ name: "HomeScreen", kind: "page", route: "/", navigatesTo: ["SettingsScreen"] }),
    ]);
    expect(summarizeScreens(g)).toEqual(["- HomeScreen [web/page] / →[SettingsScreen]"]);
  });
});
