import { describe, it, expect } from "vitest";
import { foldPassing } from "../engine/transforms/fold-passing";
import { maskAbsPaths } from "../engine/transforms/mask-abs-paths";
import { applyFilter } from "../engine/pipeline";
import { FilterDef } from "../engine/schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

describe("keep_failures + max_lines", () => {
  it("preserves failure lines beyond the cap", () => {
    const def = FilterDef.parse({ slug: "t", match_command: "x", keep_failures: true, max_lines: 2 });
    const input = ["ok 1", "ok 2", "ok 3", "FAIL boom", "ok 4"].join("\n");
    const out = applyFilter(input, def);
    expect(out).toContain("FAIL boom");
    expect(out).toContain("more lines omitted");
  });

  it("keeps the last lines (final summary) after the cap", () => {
    const def = FilterDef.parse({ slug: "t", match_command: "x", keep_failures: true, max_lines: 10, scale_with_level: false });
    const input = [...Array.from({ length: 100 }, (_, i) => `line ${i}`), "summary: done"];
    input[50] = "Error: in the middle";
    const out = applyFilter(input.join("\n"), def).split("\n");
    expect(out.slice(0, 7)).toEqual(input.slice(0, 7));
    expect(out).toContain("Error: in the middle");
    expect(out.slice(-3)).toEqual(input.slice(-3));
    expect(out).toContain("… (90 more lines omitted)");
  });
});

describe("interpreter filters cap long successful output", () => {
  const source = parseToml(readFileSync(fileURLToPath(new URL("../../filters/interpreters.toml", import.meta.url)), "utf8")) as {
    filters: Record<string, Record<string, unknown>>;
  };
  const log = Array.from({ length: 1868 }, (_, i) => `[out#0/mp4 @ 0x7711410900] sq: send 0 ts ${(i / 30).toFixed(6)}`);
  log[1867] = "frame=  300 fps=0.0 q=-1.0 Lsize=     253kB time=00:00:09.93 speed=12.1x";
  it.each(["python", "node"])("%s keeps head, tail and the last line", (slug) => {
    const def = FilterDef.parse({ slug, ...source.filters[slug] });
    const out = applyFilter(log.join("\n") + "\n", def, { verbosity: "compact" }).trimEnd().split("\n");
    expect(out.length).toBeLessThanOrEqual(121);
    expect(out[0]).toBe(log[0]);
    expect(out.at(-1)).toBe(log[1867]);
    expect(out).toContain(`… (${1868 - 120} more lines omitted)`);
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
