import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reducerConfigured, tokmizerEnabled } from "../hooks-host/quick-settings";

let dir: string;
let orig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-qs-"));
  orig = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (orig === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = orig;
});

const write = (v: unknown): void => writeFileSync(join(dir, "settings-cache.json"), JSON.stringify(v));

describe("reducerConfigured", () => {
  it("is false without a settings cache, matching the off default", () => {
    expect(reducerConfigured()).toBe(false);
  });
  it("is false when the reducer is off", () => {
    write({ enabled: true, reducer: "off" });
    expect(reducerConfigured()).toBe(false);
  });
  it("is false when tokmizer is disabled", () => {
    write({ enabled: false, reducer: "max" });
    expect(reducerConfigured()).toBe(false);
  });
  it("is true when a reducer level is set", () => {
    write({ enabled: true, reducer: "balanced" });
    expect(reducerConfigured()).toBe(true);
  });
  it("is false on a corrupt file", () => {
    writeFileSync(join(dir, "settings-cache.json"), "{nope");
    expect(reducerConfigured()).toBe(false);
  });
});

describe("tokmizerEnabled", () => {
  it("defaults to enabled without a settings cache", () => {
    expect(tokmizerEnabled()).toBe(true);
  });
  it("is false only when explicitly disabled", () => {
    write({ enabled: false });
    expect(tokmizerEnabled()).toBe(false);
    write({ reducer: "off" });
    expect(tokmizerEnabled()).toBe(true);
  });
});
