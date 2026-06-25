/**
 * scanForScreens — multi-stack heuristic detection of UI screens + composition
 * (contains) + navigation (navigatesTo) + domain attribution.
 */
import { describe, it, expect } from "vitest";
import { scanForScreens, type ScanFile } from "./detect.js";
import type { AnchorId, AstNode, FunctionNode } from "../types.js";
import type { DetectionResult } from "../domains/detect.js";

const ROOT = "/repo";
const abs = (rel: string): string => `${ROOT}/${rel}`;

function file(rel: string, text: string): ScanFile {
  return { path: abs(rel), text };
}

function fn(id: string, rel: string): FunctionNode {
  return {
    id: id as unknown as AnchorId,
    name: id,
    signature: "",
    sourceRange: { start: { line: 1, column: 0 }, end: { line: 9, column: 0 }, filePath: abs(rel) },
    bodyAst: { type: "block", children: [] } as unknown as AstNode,
  };
}

const domain = (name: string, impls: string[]): DetectionResult => ({
  domain: name,
  implementors: impls as unknown as AnchorId[],
  violations: [],
  conforms: true,
});

describe("scanForScreens", () => {
  it("detects a web component by name suffix and classifies its kind", () => {
    const files = [file("src/components/ProfileView.tsx", "export function ProfileView() { return null; }\n")];
    const g = scanForScreens(files, [], [], ROOT);
    expect(g.screens).toHaveLength(1);
    expect(g.screens[0]).toMatchObject({ name: "ProfileView", kind: "view", stack: "web", file: "src/components/ProfileView.tsx" });
  });

  it("binds a routing-table route to its component and marks it a page", () => {
    const files = [
      file("src/routes.tsx", `<Route path="/settings" element={<SettingsScreen/>} />\n`),
      file("src/screens/SettingsScreen.tsx", "export default function SettingsScreen() { return null; }\n"),
    ];
    const g = scanForScreens(files, [], [], ROOT);
    const s = g.screens.find((x) => x.name === "SettingsScreen")!;
    expect(s.kind).toBe("page");
    expect(s.route).toBe("/settings");
  });

  it("resolves navigate() targets to the routed screen name", () => {
    const files = [
      file("src/routes.tsx", `<Route path="/settings" element={<SettingsScreen/>} />\n`),
      file("src/screens/SettingsScreen.tsx", "export default function SettingsScreen() { return null; }\n"),
      file("src/screens/HomeScreen.tsx", `export default function HomeScreen() { navigate("/settings"); return null; }\n`),
    ];
    const g = scanForScreens(files, [], [], ROOT);
    const home = g.screens.find((x) => x.name === "HomeScreen")!;
    expect(home.navigatesTo).toEqual(["SettingsScreen"]);
  });

  it("reads child screens (JSX) as composition", () => {
    const files = [
      file("src/components/ProfileView.tsx", "export function ProfileView() { return null; }\n"),
      file("src/screens/DashboardScreen.tsx", "export default function DashboardScreen() { return <ProfileView/>; }\n"),
    ];
    const g = scanForScreens(files, [], [], ROOT);
    const dash = g.screens.find((x) => x.name === "DashboardScreen")!;
    expect(dash.contains).toEqual(["ProfileView"]);
  });

  it("detects a Unity UI class and a LoadScene scene + navigation edge", () => {
    const files = [
      file(
        "Game/PauseMenu.cs",
        "public class PauseMenu : MonoBehaviour {\n  void Open() { SceneManager.LoadScene(\"MainScene\"); }\n}\n",
      ),
    ];
    const g = scanForScreens(files, [], [], ROOT);
    const menu = g.screens.find((x) => x.name === "PauseMenu")!;
    expect(menu).toMatchObject({ kind: "menu", stack: "unity" });
    expect(menu.navigatesTo).toContain("MainScene");
    const scene = g.screens.find((x) => x.name === "MainScene")!;
    expect(scene.kind).toBe("scene");
  });

  it("derives a page from a Next anonymous default export and its file route", () => {
    const files = [file("src/app/dashboard/page.tsx", "export default function () { return null; }\n")];
    const g = scanForScreens(files, [], [], ROOT);
    expect(g.screens).toHaveLength(1);
    expect(g.screens[0]).toMatchObject({ kind: "page", route: "/dashboard" });
  });

  it("attributes a screen to the domains of its file's functions", () => {
    const files = [file("src/components/ProfileView.tsx", "export function ProfileView() { return null; }\n")];
    const functions = [fn("p1", "src/components/ProfileView.tsx")];
    const domains = [domain("profile", ["p1"])];
    const g = scanForScreens(files, functions, domains, ROOT);
    expect(g.screens[0]!.domains).toEqual(["profile"]);
  });

  it("treats only the file's primary component as a page (not helper sub-components)", () => {
    const files = [
      file(
        "src/pages/Companies.tsx",
        "export default function Companies() { return <Badge/>; }\n" +
          "function Badge() { return null; }\n",
      ),
    ];
    const g = scanForScreens(files, [], [], ROOT);
    expect(g.screens.map((s) => s.name)).toEqual(["Companies"]);
    expect(g.screens[0]!.kind).toBe("page");
  });

  it("ignores SCREAMING_SNAKE_CASE constants even under a screens/ dir", () => {
    const files = [file("src/screens/regexes.ts", "const ROUTE_JSX = /x/;\nexport const NAV_FN = /y/;\n")];
    const g = scanForScreens(files, [], [], ROOT);
    expect(g.screens).toHaveLength(0);
  });

  it("summarizes counts by stack and kind", () => {
    const files = [
      file("src/components/ProfileView.tsx", "export function ProfileView() { return null; }\n"),
      file("Game/PauseMenu.cs", "public class PauseMenu {}\n"),
    ];
    const g = scanForScreens(files, [], [], ROOT);
    expect(g.summary.total).toBe(2);
    expect(g.summary.byStack).toMatchObject({ web: 1, unity: 1 });
  });
});
