import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { yoloEnabled, setYoloMode } from "../yolo-mode";
import { loadSettingsCache, saveSettingsCache } from "../settings-cache";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-yolo-mode-"));
  vi.stubEnv("TOKMIZER_HOME", join(dir, "home"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("local YOLO persistence", () => {
  it("defaults off for missing, malformed and unreadable state", () => {
    expect(yoloEnabled()).toBe(false);
    const home = process.env.TOKMIZER_HOME!;
    mkdirSync(home);
    for (const value of ["off", "true", "ON", "on\n", "", "{\"yolo\":true}"]) {
      writeFileSync(join(home, "yolo-mode"), value);
      expect(yoloEnabled()).toBe(false);
    }
    rmSync(join(home, "yolo-mode"));
    mkdirSync(join(home, "yolo-mode"));
    expect(yoloEnabled()).toBe(false);
  });

  it("creates private local state and disables without creating a missing home", async () => {
    const home = process.env.TOKMIZER_HOME!;
    await setYoloMode(false);
    expect(existsSync(home)).toBe(false);
    await setYoloMode(true);
    expect(yoloEnabled()).toBe(true);
    expect(readFileSync(join(home, "yolo-mode"), "utf8")).toBe("on");
    if (process.platform !== "win32") {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "yolo-mode")).mode & 0o777).toBe(0o600);
    }
    await setYoloMode(false);
    expect(yoloEnabled()).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("atomically replaces the flag without changing readers holding the old file", async () => {
    const home = process.env.TOKMIZER_HOME!;
    mkdirSync(home);
    const path = join(home, "yolo-mode");
    writeFileSync(path, "off", { mode: 0o644 });
    const original = openSync(path, "r");
    try {
      await Promise.all([setYoloMode(true), setYoloMode(true)]);
      expect(readFileSync(original, "utf8")).toBe("off");
      expect(readFileSync(path, "utf8")).toBe("on");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(home)).toEqual(["yolo-mode"]);
    } finally {
      closeSync(original);
    }
  });

  it("preserves the original state and cleans temporary files when replacement fails", async () => {
    const home = process.env.TOKMIZER_HOME!;
    mkdirSync(join(home, "yolo-mode"), { recursive: true });
    await expect(setYoloMode(true)).rejects.toThrow();
    expect(statSync(join(home, "yolo-mode")).isDirectory()).toBe(true);
    expect(readdirSync(home)).toEqual(["yolo-mode"]);
  });

  it("survives synced settings and preserves earlier output caches on both transitions", async () => {
    const home = process.env.TOKMIZER_HOME!;
    mkdirSync(join(home, "content-cache"), { recursive: true });
    const cached = join(home, "content-cache", "previous-output");
    writeFileSync(cached, "Earlier complete output");
    await setYoloMode(true);
    const settings = await loadSettingsCache();
    await saveSettingsCache({ ...settings, outputVerbosity: "minimal" });
    expect(yoloEnabled()).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "settings-cache.json"), "utf8"))).not.toHaveProperty("yolo");
    expect(readFileSync(cached, "utf8")).toBe("Earlier complete output");
    await setYoloMode(false);
    expect(readFileSync(cached, "utf8")).toBe("Earlier complete output");
  });
});
