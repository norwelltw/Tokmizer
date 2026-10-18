import { describe, it, expect } from "vitest";
import { foldPassing } from "../engine/transforms/fold-passing";
import { maskAbsPaths } from "../engine/transforms/mask-abs-paths";
import { applyFilter } from "../engine/pipeline";
import { FilterDef } from "../engine/schema";

describe("keep_failures + max_lines", () => {
  it("preserves failure lines beyond the cap", () => {
    const def = FilterDef.parse({ slug: "t", match_command: "x", keep_failures: true, max_lines: 2 });
    const input = ["ok 1", "ok 2", "ok 3", "FAIL boom", "ok 4"].join("\n");
    const out = applyFilter(input, def);
    expect(out).toContain("FAIL boom");
    expect(out).toContain("more lines omitted");
  });
});

describe("foldPassing", () => {
  it("folds a run of passing lines >= threshold into a counter", () => {
    const lines = [
      "PASS  src/auth.test.js",
      "  ✓ a (1 ms)",
      "  ✓ b (2 ms)",
      "  ✓ c (3 ms)",
      "  ✓ d (4 ms)",
      "  ✓ e (5 ms)",
      "Tests: 28 passed"
    ];
    const out = foldPassing(lines, 5);
    expect(out).toContain("… 5 passing checks folded …");
    expect(out).toContain("PASS  src/auth.test.js");
    expect(out).toContain("Tests: 28 passed");
    expect(out.some((l) => l.includes("✓ a"))).toBe(false);
  });

  it("keeps passing runs shorter than threshold", () => {
    const lines = ["  ✓ a", "  ✓ b", "FAIL x"];
    expect(foldPassing(lines, 5)).toEqual(lines);
  });

  it("never folds failure or summary lines", () => {
    const lines = ["  ✕ broke", "  ✕ also broke", "Expected: 1", "Received: 2", "Tests: 1 failed"];
    expect(foldPassing(lines, 2)).toEqual(lines);
  });
});

describe("maskAbsPaths", () => {
  it("shortens deep absolute paths to the last two segments", () => {
    const out = maskAbsPaths(["at /Users/dana/projects/shop/src/cart.test.js:42"]);
    expect(out[0]).toBe("at …/src/cart.test.js:42");
  });

  it("leaves short paths and non-paths untouched", () => {
    expect(maskAbsPaths(["/usr/bin", "no path here"])).toEqual(["/usr/bin", "no path here"]);
  });
});
