import { describe, expect, it } from "vitest";
import { getTransform } from "../engine/transforms/registry";
import "../engine/transforms/strip-banners";

const strip = getTransform("strip-banners")!;
const run = (s: string): string[] => strip(s.split("\n"));

describe("strip-banners", () => {
  it("unwraps the `=` rule around a summary line", () => {
    expect(run("===== 3011 passed in 0.93s =====")).toEqual(["3011 passed in 0.93s"]);
  });

  it("drops lines that are only a rule", () => {
    expect(run("==========")).toEqual([]);
  });

  it("never touches `==` inside a line (tracebacks survive)", () => {
    const failing = ["FAILURES", ">   assert 2 == 3", "E   assert 2 == 3", "1 failed in 0.1s"];
    expect(run(failing.join("\n"))).toEqual(failing);
  });

  it("cleans section headers but keeps their text", () => {
    expect(run("=== short test summary info ===")).toEqual(["short test summary info"]);
  });

  it("leaves a trailing `key =` untouched (no decoration strip)", () => {
    expect(run("key =")).toEqual(["key ="]);
  });

  it("leaves `total=42` and `assert a == b` untouched", () => {
    expect(run("total=42")).toEqual(["total=42"]);
    expect(run("assert a == b")).toEqual(["assert a == b"]);
  });

  it("leaves a make error line untouched", () => {
    expect(run("make: *** [t] Error 1")).toEqual(["make: *** [t] Error 1"]);
  });

  it("drops a pure rule but keeps a leading-only `=` decorated line", () => {
    expect(run("=====")).toEqual([]);
    expect(run("== leading only")).toEqual(["== leading only"]);
  });

  it("does not catastrophically backtrack on a long pseudo-banner line", () => {
    const poison = "= " + " ".repeat(3000) + "a";
    const start = performance.now();
    const result = run(poison);
    const elapsed = performance.now() - start;
    expect(result).toEqual([poison]);
    expect(elapsed).toBeLessThan(50);
  }, 20000);
});
