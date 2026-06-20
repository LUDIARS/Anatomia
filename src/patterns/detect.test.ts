/**
 * scanForPatterns — source-scan heuristic detection of singleton / locator /
 * facade declarations, plus accessor-domain attribution via enclosing function.
 */
import { describe, it, expect } from "vitest";
import { scanForPatterns, type ScanFile } from "./detect.js";
import type { AnchorId, AstNode, FunctionNode } from "../types.js";
import type { DetectionResult } from "../domains/detect.js";

const ROOT = "/repo";
const abs = (rel: string) => `${ROOT}/${rel}`;

function file(rel: string, text: string): ScanFile {
  return { path: abs(rel), text };
}

/** A function spanning [start,end] in `rel`, with anchor id. */
function fn(id: string, rel: string, start: number, end: number): FunctionNode {
  return {
    id: id as unknown as AnchorId,
    name: id,
    signature: "",
    sourceRange: { start: { line: start, column: 0 }, end: { line: end, column: 0 }, filePath: abs(rel) },
    bodyAst: { type: "block", children: [] } as unknown as AstNode,
  };
}

const domain = (name: string, impls: string[]): DetectionResult => ({
  domain: name,
  implementors: impls as unknown as AnchorId[],
  violations: [],
  conforms: true,
});

describe("scanForPatterns", () => {
  it("detects a C# static-property singleton (the Unity form) by enclosing class", () => {
    const files = [
      file("Game/GameManager.cs",
        "namespace G {\n  public class GameManager {\n    public static GameManager Instance { get; private set; }\n  }\n}\n"),
      file("Audio/Bgm.cs",
        "public class Bgm {\n  public static Bgm Instance => _i;\n}\n"),
    ];
    const out = scanForPatterns(files, [], [], ROOT);
    const singletons = out.filter((p) => p.kind === "singleton").map((p) => p.name).sort();
    expect(singletons).toEqual(["Bgm", "GameManager"]);
  });

  it("attributes accessing domains + access kind from Type.Instance usages", () => {
    const files = [
      file("Game/GameManager.cs",
        "public class GameManager {\n  public static GameManager Instance { get; private set; }\n}\n"),
      // combat reads GameManager.Instance inside fn c1 (lines 1-3)
      file("Combat/Weapon.cs",
        "void Fire() {\n  var hp = GameManager.Instance.Player;\n}\n"),
      // ui reads it inside fn u1 (lines 1-3)
      file("Ui/Hud.cs",
        "void Draw() {\n  GameManager.Instance.Score.ToString();\n}\n"),
    ];
    const functions = [fn("c1", "Combat/Weapon.cs", 1, 3), fn("u1", "Ui/Hud.cs", 1, 3)];
    const domains = [domain("combat", ["c1"]), domain("ui", ["u1"])];
    const out = scanForPatterns(files, functions, domains, ROOT);
    const gm = out.find((p) => p.name === "GameManager")!;
    expect(gm).toBeTruthy();
    expect(gm.accessors).toEqual([
      { domain: "combat", access: "reads" },
      { domain: "ui", access: "reads" },
    ]);
  });

  it("detects a service-locator resolve only inside a locator-ish file", () => {
    const files = [
      file("Core/ServiceLocator.cs",
        "public class ServiceLocator {\n  public T Resolve<T>() { return default; }\n}\n"),
      file("Combat/Weapon.cs",
        "public class Weapon {\n  public T Resolve<T>() { return default; }\n}\n"), // not a locator file → skip
    ];
    const out = scanForPatterns(files, [], [], ROOT);
    const locs = out.filter((p) => p.kind === "service-locator").map((p) => p.name);
    expect(locs).toEqual(["ServiceLocator"]);
  });

  it("detects facade classes by *Facade name", () => {
    const files = [file("Ui/UiFacade.cs", "public class UiFacade {\n  public void Open() {}\n}\n")];
    const out = scanForPatterns(files, [], [], ROOT);
    expect(out.filter((p) => p.kind === "facade").map((p) => p.name)).toEqual(["UiFacade"]);
  });

  it("does not flag a private lowercase backing field as the accessor", () => {
    const files = [file("X/X.cs", "public class X {\n  static X instance;\n  void use() { X.foo(); }\n}\n")];
    const out = scanForPatterns(files, [], [], ROOT);
    // lowercase `instance` field is not the public accessor → no singleton.
    expect(out.filter((p) => p.kind === "singleton")).toHaveLength(0);
  });

  it("detects network clients by name suffix and classifies the target server", () => {
    const files = [
      file("Ranking/EndlessRankingApiClient.cs", "public class EndlessRankingApiClient {\n  void Post() {}\n}\n"),
      file("Auth/LoginApiClient.cs", "public class LoginApiClient {\n}\n"),
      file("Net/OBSWebSocketClient.cs", "public class OBSWebSocketClient {\n}\n"),
    ];
    const out = scanForPatterns(files, [], [], ROOT);
    const byName = Object.fromEntries(out.filter((p) => p.kind === "network").map((p) => [p.name, p.target]));
    expect(byName["EndlessRankingApiClient"]).toBe("ランキングサーバ");
    expect(byName["LoginApiClient"]).toBe("ログインサーバ");
    expect(byName["OBSWebSocketClient"]).toBe("APIサーバ"); // default role
  });

  it("detects a network class via a networking API token (UnityWebRequest)", () => {
    const files = [
      file("Sys/Uploader.cs", "public class Uploader {\n  void Go() { var r = UnityWebRequest.Get(url); }\n}\n"),
    ];
    const out = scanForPatterns(files, [], [], ROOT);
    expect(out.filter((p) => p.kind === "network").map((p) => p.name)).toEqual(["Uploader"]);
  });

  it("attributes network communication to the domain owning the client", () => {
    const files = [
      file("Ranking/RankingApiClient.cs", "public class RankingApiClient {\n  public void Submit() {}\n}\n"),
    ];
    const functions = [fn("r1", "Ranking/RankingApiClient.cs", 1, 3)];
    const domains = [domain("ranking", ["r1"])];
    const out = scanForPatterns(files, functions, domains, ROOT);
    const net = out.find((p) => p.kind === "network")!;
    expect(net.target).toBe("ランキングサーバ");
    expect(net.accessors).toEqual([{ domain: "ranking", access: "calls" }]);
  });
});
