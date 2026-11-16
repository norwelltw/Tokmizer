import { foldSimilarRuns } from "../engine/transforms/fold-similar";
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
    // The repeated `sq: send` lines fold to one run: first, marker, last, then the summary.
    expect(out).toEqual([log[0], "… 1865 similar log lines dropped, no errors …", log[1866], log[1867]]);
  });

  it.each(["python", "node"])("%s folds similar lines and still cuts what stays too long", (slug) => {
    const def = FilterDef.parse({ slug, ...source.filters[slug] });
    const lines = Array.from({ length: 400 }, (_, i) => `${"abcdefghijklmnopqrstuvwxyz"[i % 26]!.repeat(3)} unique line`);
    const mixed = [...lines.slice(0, 200), ...Array.from({ length: 50 }, (_, i) => `step ${i}/50 ok`), "ERROR disk full", ...lines.slice(200)];
    const out = applyFilter(mixed.join("\n") + "\n", def, { verbosity: "compact" }).trimEnd().split("\n");
    expect(out.length).toBeLessThanOrEqual(121 + 1);
    expect(out).toContain("ERROR disk full");
    expect(out.at(-1)).toBe(mixed.at(-1));
  });
});

describe("foldSimilarRuns", () => {
  it("never folds data rows, lowercase errors, or a run shorter than its marker", () => {
    const table = Array.from({ length: 30 }, (_, i) => `${i}, ${i * 3}.5, ${i % 7}`);
    expect(foldSimilarRuns(table).kept).toEqual(table);
    const json = ["[", ...Array.from({ length: 30 }, (_, i) => `  ${i * 3},`), "]"];
    expect(foldSimilarRuns(json).kept).toEqual(json);
    const decode = Array.from({ length: 30 }, (_, i) => `[h264 @ 0x7f8a1c00] error while decoding MB ${i} 34, bytestream -5`);
    expect(foldSimilarRuns(decode).kept).toEqual(decode);
    const tiny = ["step 1", "step 2", "step 3", "step 4"];
    expect(foldSimilarRuns(tiny).kept).toEqual(tiny);
  });

  it("folds runs of four or more lines differing only by numbers, never error lines", () => {
    const lines = ["start", ...Array.from({ length: 6 }, (_, i) => `frame ${i} at ${i * 1.5}s`), "ERROR 1 bad", "ERROR 2 bad", "ERROR 3 bad", "ERROR 4 bad", "a 1", "a 2", "a 3", "end"];
    expect(foldSimilarRuns(lines)).toEqual({
      kept: ["start", "frame 0 at 0s", "… 4 similar log lines dropped …", "frame 5 at 7.5s", "ERROR 1 bad", "ERROR 2 bad", "ERROR 3 bad", "ERROR 4 bad", "a 1", "a 2", "a 3", "end"],
      dropped: ["frame 1 at 1.5s", "frame 2 at 3s", "frame 3 at 4.5s", "frame 4 at 6s"]
    });
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
