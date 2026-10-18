import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasNativeHook } from "../host-detect";
import { resolveSinceDays } from "../stats";

describe("hasNativeHook (shim double-count guard)", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tkr-gain-audit-"));
    for (const key of ["HOME", "USERPROFILE", "GEMINI_CLI_HOME"]) {
      saved[key] = process.env[key];
      process.env[key] = home;
    }
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  it("is true for hosts that have a native PostToolUse hook", () => {
    expect(hasNativeHook("claude-code")).toBe(true);
    expect(hasNativeHook("codex")).toBe(true);
  });
  it("is false for shim-only hosts where the shim must record", () => {
    expect(hasNativeHook("shell")).toBe(false);
    expect(hasNativeHook("cursor")).toBe(false);
    expect(hasNativeHook("gemini-cli")).toBe(false);
    expect(hasNativeHook("aider")).toBe(false);
  });
});

describe("resolveSinceDays (honest install age)", () => {
  const NOW = 1_700_000_000; // seconds (realistic epoch)

  it("uses installedAt when present, even if the oldest retained record is newer", () => {
    const installedAt = NOW - 30 * 86400;
    expect(resolveSinceDays(installedAt, NOW, 5)).toBe(30);
  });

  it("falls back to the data-span days when installedAt is missing", () => {
    expect(resolveSinceDays(undefined, NOW, 7)).toBe(7);
  });

  it("never returns less than 1", () => {
    expect(resolveSinceDays(NOW, NOW, 1)).toBe(1);
    expect(resolveSinceDays(NOW + 100, NOW, 1)).toBe(1);
  });

  it("ignores a corrupt zero/epoch installedAt and uses the fallback", () => {
    expect(resolveSinceDays(0, NOW, 4)).toBe(4);
  });
});
