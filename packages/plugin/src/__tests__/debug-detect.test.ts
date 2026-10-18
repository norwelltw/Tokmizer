import { describe, expect, it } from "vitest";
import { looksLikeFailure } from "../engine/debug-detect";

describe("looksLikeFailure", () => {
  it("false on empty", () => {
    expect(looksLikeFailure("")).toBe(false);
  });

  it("false on green log", () => {
    expect(looksLikeFailure("Build OK\n12 files transpiled\nDone in 4s")).toBe(false);
  });

  it("detects ERROR", () => {
    expect(looksLikeFailure("ERROR: cannot find module")).toBe(true);
  });

  it("detects FAIL/FAILED", () => {
    expect(looksLikeFailure("Tests FAILED (3 of 12)")).toBe(true);
    expect(looksLikeFailure("FAIL: auth.test.ts")).toBe(true);
  });

  it("detects python Traceback", () => {
    const py = "Traceback (most recent call last):\n  File \"a.py\", line 1";
    expect(looksLikeFailure(py)).toBe(true);
  });

  it("detects node Error: prefix", () => {
    expect(looksLikeFailure("Error: ENOENT no such file")).toBe(true);
  });

  it("detects v8 stack frame", () => {
    expect(looksLikeFailure("    at MyClass.run (/a/b/c.js:42:11)")).toBe(true);
  });

  it("detects go panic", () => {
    expect(looksLikeFailure("panic: runtime error")).toBe(true);
  });

  it("detects JS error classes", () => {
    expect(looksLikeFailure("SyntaxError: Unexpected token")).toBe(true);
    expect(looksLikeFailure("TypeError: undefined is not a function")).toBe(true);
    expect(looksLikeFailure("ReferenceError: x is not defined")).toBe(true);
    expect(looksLikeFailure("AssertionError: expected 42, got 0")).toBe(true);
  });

  it("detects a lowercase diagnostic prefix without matching prose", () => {
    expect(looksLikeFailure("  error: cannot parse config")).toBe(true);
    expect(looksLikeFailure("fatal: missing repository")).toBe(true);
    expect(looksLikeFailure("error handling enabled")).toBe(false);
  });

  it("detects rust panic", () => {
    expect(looksLikeFailure("thread 'main' panicked at 'foo'")).toBe(true);
  });

  it("case-sensitive on ERROR/FAIL (no fail in 'failing words')", () => {
    expect(looksLikeFailure("error happened")).toBe(false);
    expect(looksLikeFailure("failed here")).toBe(false);
  });
});

describe("looksLikeFailure boundary scope", () => {
  it("detects an ERROR marker buried mid-output", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    lines[100] = "ERROR: something in the middle";
    expect(looksLikeFailure(lines.join("\n"))).toBe(true);
  });

  it("still detects a failure marker in the first lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    lines[2] = "Error: ENOENT no such file";
    expect(looksLikeFailure(lines.join("\n"))).toBe(true);
  });

  it("still detects a failure marker in the last lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    lines[197] = "Tests FAILED (3 of 12)";
    expect(looksLikeFailure(lines.join("\n"))).toBe(true);
  });

  it("detects a lowercase nonzero failure summary", () => {
    expect(looksLikeFailure("1 failed, 120 passed in 0.32s")).toBe(true);
    expect(looksLikeFailure("0 failed, 120 passed in 0.32s")).toBe(false);
  });

  it("does not treat a passing test name as a failure", () => {
    expect(looksLikeFailure(" ✓ handles ERROR and FAIL in log messages\n296 passed (296)")).toBe(false);
  });
});
