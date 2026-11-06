import { describe, expect, it } from "vitest";
import { rulesOf } from "./helpers.js";

describe("memory rules (Rust-style ownership)", () => {
  it("flags raw new/delete and C allocation, not placement new or make_unique", async () => {
    const src = [
      "void f(void* buf) {",
      "  int* p = new int(1);",
      "  delete p;",
      "  void* m = malloc(4);",
      "  std::free(m);",
      "  auto q = std::make_unique<int>(2);",
      "  new (buf) int(3);",
      "}",
    ].join("\n");
    expect(await rulesOf(src, "memory/")).toEqual([
      "memory/raw-new@2",
      "memory/raw-delete@3",
      "memory/c-allocation@4",
      "memory/c-allocation@5",
    ]);
  });

  it("flags the first use after std::move but not a reassignment or reset", async () => {
    const used = "void f(std::string s) {\n  take(std::move(s));\n  print(s);\n}";
    expect(await rulesOf(used, "memory/use-after-move")).toEqual(["memory/use-after-move@3"]);

    const reassigned = "void f(std::string s) {\n  take(std::move(s));\n  s = \"new\";\n  print(s);\n}";
    expect(await rulesOf(reassigned, "memory/use-after-move")).toEqual([]);

    const cleared = "void f(std::vector<int> v) {\n  take(std::move(v));\n  v.clear();\n  print(v);\n}";
    expect(await rulesOf(cleared, "memory/use-after-move")).toEqual([]);
  });

  it("does not treat a later same-named declaration as the moved variable", async () => {
    const src = [
      "void f(std::vector<Pass>& out) {",
      "  { Pass p; out.push_back(std::move(p)); }",
      "  { Pass p; p.name = \"b\"; out.push_back(std::move(p)); }",
      "}",
    ].join("\n");
    expect(await rulesOf(src, "memory/use-after-move")).toEqual([]);
  });

  it("does not flag text after a move whose block returns right away", async () => {
    const src = [
      "bool read(std::string& out) {",
      "  std::string s;",
      "  while (more()) {",
      "    if (done()) { out = std::move(s); return true; }",
      "    s.push_back(next());",
      "  }",
      "  return false;",
      "}",
    ].join("\n");
    expect(await rulesOf(src, "memory/use-after-move")).toEqual([]);
  });

  it("does not pair a move and a use in exclusive if/else arms", async () => {
    const src = "void f(std::string s, bool c) {\n  if (c) { take(std::move(s)); } else { print(s); }\n}";
    expect(await rulesOf(src, "memory/use-after-move")).toEqual([]);
  });

  it("flags returning a pointer or reference to a local, not to a static or a parameter reference", async () => {
    const src = [
      "int* a() { int x = 1; return &x; }",
      "int& b() { int y = 2; return y; }",
      "int& c() { static int z = 3; return z; }",
      "int& d(int& r) { return r; }",
      "const std::string& e(std::string v) { return v; }",
    ].join("\n");
    expect(await rulesOf(src, "memory/dangling-return")).toEqual([
      "memory/dangling-return@1",
      "memory/dangling-return@2",
      "memory/dangling-return@5",
    ]);
  });

  it("flags reinterpret_cast, const_cast and C-style pointer casts, not static_cast", async () => {
    const src = [
      "void f(long v, const int* c) {",
      "  auto p = reinterpret_cast<int*>(v);",
      "  auto q = const_cast<int*>(c);",
      "  auto r = (char*)c;",
      "  auto s = static_cast<int>(v);",
      "}",
    ].join("\n");
    expect(await rulesOf(src, "memory/unsafe-cast")).toEqual([
      "memory/unsafe-cast@2",
      "memory/unsafe-cast@3",
      "memory/unsafe-cast@4",
    ]);
  });
});
