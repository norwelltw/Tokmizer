import { describe, expect, it } from "vitest";
import { FilterDef } from "../engine/schema";
import { applyFilter } from "../engine/pipeline";
import type { LoadedFilter } from "../engine/loader";

describe("FilterDef scale_with_level", () => {
  it("defaults to true", () => {
    const def = FilterDef.parse({ slug: "x", match_command: "^x" });
    expect(def.scale_with_level).toBe(true);
  });
  it("can be set false", () => {
    const def = FilterDef.parse({ slug: "x", match_command: "^x", scale_with_level: false });
    expect(def.scale_with_level).toBe(false);
  });
});

function filter(over: Record<string, unknown>): LoadedFilter {
  const def = FilterDef.parse({ slug: "x", match_command: "^x", ...over });
  return { ...def, matchRegex: /^x/ };
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");

describe("applyFilter cap scaling", () => {
  it("caps at base max_lines on light (normal)", () => {
    const out = applyFilter(lines(100), filter({ max_lines: 50 }), { verbosity: "normal" });
    expect(out.split("\n").filter((l) => l.startsWith("l")).length).toBe(50);
  });
  it("caps harder on max (minimal): 100 * 0.3 = 30", () => {
    const out = applyFilter(lines(200), filter({ max_lines: 100 }), { verbosity: "minimal" });
    expect(out.split("\n").filter((l) => l.startsWith("l")).length).toBe(30);
  });
  it("never goes below the floor of 20", () => {
    const out = applyFilter(lines(100), filter({ max_lines: 30 }), { verbosity: "minimal" });
    expect(out.split("\n").filter((l) => l.startsWith("l")).length).toBe(20);
  });
  it("ignores the multiplier when scale_with_level is false", () => {
    const out = applyFilter(lines(100), filter({ max_lines: 50, scale_with_level: false }), { verbosity: "minimal" });
    expect(out.split("\n").filter((l) => l.startsWith("l")).length).toBe(50);
  });
});
