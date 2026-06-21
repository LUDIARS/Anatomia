/**
 * scanForPatterns — source-scan heuristic detection of singleton / locator /
 * facade declarations, plus accessor-domain attribution via enclosing function.
 */
import { describe, it, expect } from "vitest";
import { scanForPatterns, type ScanFile, type ClassFanOut } from "./detect.js";
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

  // ── #321: trace network clients to their calling domains via DI ────────────

  it("traces a network client to the domain that resolves it through a DI-bound interface", () => {
    const files = [
      // Owner: the client class itself, in the ranking domain.
      file("Ranking/RankingApiClient.cs", "public class RankingApiClient {\n  public void Submit() {}\n}\n"),
      // DI wiring: binds the interface to the concrete client. No analyzed
      // function here → the concrete token on this line attributes nothing.
      file("Core/Bindings.cs", "Register<IRankingClient, RankingApiClient>();\n"),
      // Consumer: the ui domain resolves the *interface* and calls it.
      file("Ui/Leaderboard.cs", "void Show() {\n  var c = Resolve<IRankingClient>();\n  c.Fetch();\n}\n"),
    ];
    const functions = [
      fn("r1", "Ranking/RankingApiClient.cs", 1, 3),
      fn("u1", "Ui/Leaderboard.cs", 1, 4),
    ];
    const domains = [domain("ranking", ["r1"]), domain("ui", ["u1"])];
    const out = scanForPatterns(files, functions, domains, ROOT);
    const net = out.find((p) => p.kind === "network")!;
    // Owner (ranking) AND the resolving consumer (ui) are now both attributed.
    expect(net.accessors).toEqual([
      { domain: "ranking", access: "calls" },
      { domain: "ui", access: "calls" },
    ]);
  });

  it("traces a network client referenced as a typed field at class scope", () => {
    const files = [
      file("Net/GameServerClient.cs", "public class GameServerClient {\n  public void Send() {}\n}\n"),
      // A combat class holds the concrete client as an injected field (class
      // scope, not inside a function) → attributed to the file's domain.
      file("Combat/Battle.cs", "public class Battle {\n  GameServerClient _client;\n  void Tick() {}\n}\n"),
    ];
    const functions = [
      fn("g1", "Net/GameServerClient.cs", 1, 3),
      fn("b1", "Combat/Battle.cs", 3, 3), // Tick(); the field decl on line 2 is class-scope
    ];
    const domains = [domain("net", ["g1"]), domain("combat", ["b1"])];
    const out = scanForPatterns(files, functions, domains, ROOT);
    const net = out.find((p) => p.kind === "network")!;
    expect(net.accessors).toEqual([
      { domain: "combat", access: "calls" },
      { domain: "net", access: "calls" },
    ]);
  });

  // ── #323: structural facades from graph fan-out ────────────────────────────

  it("flags a high fan-out class as a structural facade with caller domains", () => {
    const classFanOut = new Map<string, ClassFanOut>([
      ["BigHub", { distinctCallees: 15, calleeDomains: 3, callerDomains: ["ui", "combat"], file: "Hub/BigHub.cs", line: 2 }],
      ["Small", { distinctCallees: 3, calleeDomains: 1, callerDomains: ["ui"], file: "X/Small.cs", line: 1 }],
    ]);
    const out = scanForPatterns([], [], [], ROOT, { classFanOut });
    const facades = out.filter((p) => p.kind === "facade");
    expect(facades.map((p) => p.name)).toEqual(["BigHub"]); // Small is below threshold
    const hub = facades[0]!;
    expect(hub.reason).toContain("structural facade");
    expect(hub.file).toBe("Hub/BigHub.cs");
    expect(hub.accessors).toEqual([
      { domain: "combat", access: "calls" },
      { domain: "ui", access: "calls" },
    ]);
  });

  it("does not flag a high fan-out class that spans only one domain", () => {
    const classFanOut = new Map<string, ClassFanOut>([
      ["MonoHub", { distinctCallees: 20, calleeDomains: 1, callerDomains: ["ui"], file: "X/MonoHub.cs", line: 1 }],
    ]);
    const out = scanForPatterns([], [], [], ROOT, { classFanOut });
    expect(out.filter((p) => p.kind === "facade")).toHaveLength(0);
  });

  it("does not relabel an already name-detected facade as a structural one", () => {
    const files = [file("Ui/UiFacade.cs", "public class UiFacade {\n  public void Open() {}\n}\n")];
    const classFanOut = new Map<string, ClassFanOut>([
      ["UiFacade", { distinctCallees: 99, calleeDomains: 5, callerDomains: ["combat"], file: "Ui/UiFacade.cs", line: 1 }],
    ]);
    const out = scanForPatterns(files, [], [], ROOT, { classFanOut });
    const facades = out.filter((p) => p.kind === "facade");
    expect(facades).toHaveLength(1); // single entry, no structural duplicate
    expect(facades[0]!.reason).toContain("facade-named"); // the named detection wins
  });
});
