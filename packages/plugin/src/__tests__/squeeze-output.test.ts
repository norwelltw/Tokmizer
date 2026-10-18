import { describe, expect, it } from "vitest";
import { squeezeOutput } from "../engine/transforms/squeeze-output";

describe("squeezeOutput", () => {
  it("collapses 3+ identical consecutive lines into a counter", () => {
    const out = squeezeOutput(["a", "a", "a", "a", "b"]);
    expect(out).toEqual(["a", "  … (repeated 4x)", "b"]);
  });

  it("keeps pairs untouched", () => {
    expect(squeezeOutput(["x", "x", "y"])).toEqual(["x", "x", "y"]);
  });

  it("squeezes blank line runs to one", () => {
    expect(squeezeOutput(["a", "", "", "", "b"])).toEqual(["a", "", "b"]);
  });

  it("strips trailing whitespace and trailing blank lines", () => {
    expect(squeezeOutput(["a  ", "", ""])).toEqual(["a"]);
  });

  it("never drops distinct content", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `row ${i}`);
    expect(squeezeOutput(lines)).toEqual(lines);
  });
});
