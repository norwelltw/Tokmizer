import { describe, it, expect } from "vitest";
import { isOlderVersion } from "../version";

describe("isOlderVersion", () => {
  it("detects an older running version", () => {
    expect(isOlderVersion("0.5.9", "0.9.0")).toBe(true);
    expect(isOlderVersion("0.8.2", "0.9.0")).toBe(true);
    expect(isOlderVersion("0.9.0", "0.10.0")).toBe(true);
  });

  it("returns false when equal or newer", () => {
    expect(isOlderVersion("0.9.0", "0.9.0")).toBe(false);
    expect(isOlderVersion("0.9.1", "0.9.0")).toBe(false);
    expect(isOlderVersion("1.0.0", "0.9.0")).toBe(false);
  });

  it("compares numerically, not lexically (10 > 9)", () => {
    expect(isOlderVersion("0.9.0", "0.10.0")).toBe(true);
    expect(isOlderVersion("0.10.0", "0.9.0")).toBe(false);
  });

  it("is safe on missing or malformed input", () => {
    expect(isOlderVersion("", "0.9.0")).toBe(false);
    expect(isOlderVersion("0.9.0", "")).toBe(false);
    expect(isOlderVersion("0.9.0", undefined)).toBe(false);
  });
});
