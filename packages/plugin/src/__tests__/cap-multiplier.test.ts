import { describe, expect, it } from "vitest";
import { capMultiplier } from "../engine/pipeline";

describe("capMultiplier", () => {
  it("maps normal (light) to 1.0", () => {
    expect(capMultiplier("normal")).toBe(1.0);
  });
  it("maps compact (balanced) to 0.6", () => {
    expect(capMultiplier("compact")).toBe(0.6);
  });
  it("maps minimal (max) to 0.3", () => {
    expect(capMultiplier("minimal")).toBe(0.3);
  });
  it("defaults unknown/undefined to 1.0", () => {
    expect(capMultiplier(undefined)).toBe(1.0);
    expect(capMultiplier("weird" as never)).toBe(1.0);
  });
});
