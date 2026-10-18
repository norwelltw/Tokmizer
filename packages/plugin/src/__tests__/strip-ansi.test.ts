import { describe, expect, it } from "vitest";
import { stripAnsi } from "../engine/transforms/strip-ansi";

describe("stripAnsi", () => {
  it("strips a CSI SGR sequence with leading ESC", () => {
    expect(stripAnsi("[31mred[0m")).toBe("red");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("strips multiple CSI sequences", () => {
    expect(stripAnsi("a[1mb[22mc[2;3Hd")).toBe("abcd");
  });

  it("strips OSC sequences", () => {
    expect(stripAnsi("]0;titlehello")).toBe("hello");
  });

  it("does not match bracket text without ESC prefix", () => {
    expect(stripAnsi("[31m] not ansi")).toBe("[31m] not ansi");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});
