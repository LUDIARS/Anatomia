/**
 * Pure deep-link logic (src/adapters/web/public/deeplink-logic.js).
 * Parses the Thaleia-issued `?project=&focus=` query and resolves which loaded
 * domain / scene a focus token matches; extracted from index.html so it is
 * testable without a browser.
 */
import { describe, it, expect } from "vitest";
import {
  parseDeeplink,
  findDomainMatch,
  findSceneMatch,
} from "./deeplink-logic.js";

describe("parseDeeplink", () => {
  it("reads project + focus from a leading-? query string", () => {
    expect(parseDeeplink("?project=ks&focus=combat")).toEqual({
      project: "ks",
      focus: "combat",
    });
  });
  it("accepts a query string without the leading ?", () => {
    expect(parseDeeplink("project=ks&focus=combat")).toEqual({
      project: "ks",
      focus: "combat",
    });
  });
  it("accepts a full URL and decodes percent-encoding", () => {
    expect(
      parseDeeplink("http://127.0.0.1:4200/?project=my%20proj&focus=ui%2Fhud"),
    ).toEqual({ project: "my proj", focus: "ui/hud" });
  });
  it("nulls out absent / blank values", () => {
    expect(parseDeeplink("?project=ks")).toEqual({ project: "ks", focus: null });
    expect(parseDeeplink("?focus=combat")).toEqual({
      project: null,
      focus: "combat",
    });
    expect(parseDeeplink("?project=&focus=%20")).toEqual({
      project: null,
      focus: null,
    });
    expect(parseDeeplink("")).toEqual({ project: null, focus: null });
    expect(parseDeeplink(null)).toEqual({ project: null, focus: null });
  });
});

describe("findDomainMatch", () => {
  const views = [{ domain: "combat" }, { domain: "UI" }, { domain: "meta" }];
  it("matches a domain name exactly", () => {
    expect(findDomainMatch(views, "combat")).toBe(views[0]);
  });
  it("matches case-insensitively (so an upstream label casing diff still lands)", () => {
    expect(findDomainMatch(views, "ui")).toBe(views[1]);
    expect(findDomainMatch(views, "  Meta ")).toBe(views[2]);
  });
  it("returns null for an unknown focus (no fuzzy/substring guess)", () => {
    expect(findDomainMatch(views, "comb")).toBeNull();
    expect(findDomainMatch(views, "audio")).toBeNull();
  });
  it("tolerates missing inputs", () => {
    expect(findDomainMatch(null, "combat")).toBeNull();
    expect(findDomainMatch(views, null)).toBeNull();
    expect(findDomainMatch(views, "")).toBeNull();
  });
});

describe("findSceneMatch", () => {
  const sceneModules = {
    scenes: [
      { id: "battle", label: "戦闘" },
      { id: "title", label: "Title" },
    ],
  };
  it("matches a scene by id", () => {
    expect(findSceneMatch(sceneModules, "battle")).toBe("battle");
  });
  it("matches a scene by label (case-folded)", () => {
    expect(findSceneMatch(sceneModules, "戦闘")).toBe("battle");
    expect(findSceneMatch(sceneModules, "title")).toBe("title");
  });
  it("returns the id, not the object", () => {
    expect(findSceneMatch(sceneModules, "Title")).toBe("title");
  });
  it("returns null for an unknown focus", () => {
    expect(findSceneMatch(sceneModules, "boss")).toBeNull();
  });
  it("tolerates missing inputs", () => {
    expect(findSceneMatch(null, "battle")).toBeNull();
    expect(findSceneMatch({}, "battle")).toBeNull();
    expect(findSceneMatch(sceneModules, null)).toBeNull();
  });
});
