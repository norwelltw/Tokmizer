import { describe, expect, it } from "vitest";
import { smartCodeCollapse, FOLD_MARKER_RE } from "../engine/transforms/smart-code";

const FN = [
  "function compute(a, b) {",
  "  const x = a + b;",
  "  const y = x * 2;",
  "  const z = y - a;",
  "  return z;",
  "}"
];

describe("smartCodeCollapse line-count contract", () => {
  it("emits exactly as many lines as it consumed (numbering stays true)", () => {
    const out = smartCodeCollapse(FN);
    expect(out.length).toBe(FN.length);
  });

  it("keeps the declaration and closing lines verbatim", () => {
    const out = smartCodeCollapse(FN);
    expect(out[0]).toBe("function compute(a, b) {");
    expect(out[out.length - 1]).toBe("}");
  });

  it("announces the folded body with an honest marker", () => {
    const out = smartCodeCollapse(FN);
    expect(out.some((l) => FOLD_MARKER_RE.test(l))).toBe(true);
    const marker = out.find((l) => FOLD_MARKER_RE.test(l))!;
    expect(marker).toContain("4 lines folded");
  });

  it("preserves count across a whole file with several folds", () => {
    const file = [...FN, "", "const K = 1;", ...FN.map((l) => l.replace("compute", "other")), ""];
    const out = smartCodeCollapse(file);
    expect(out.length).toBe(file.length);
    expect(out[7]).toBe("const K = 1;");
  });

  it("leaves a two-line (empty body) block untouched", () => {
    const tiny = ["function empty() {", "}"];
    expect(smartCodeCollapse(tiny)).toEqual(tiny);
  });
});
