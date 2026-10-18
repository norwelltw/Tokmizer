import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettingsCache, saveSettingsCache, updateSettingsCache } from "../settings-cache";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

const nativePlatform = process.platform;
let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-settings-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: nativePlatform });
  vi.mocked((await import("node:fs/promises")).rename).mockReset();
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
});

describe("settings-cache", () => {
  it.each(["EPERM", "EBUSY"])("retries a transient Windows %s while retaining the choosing ticket", async (code) => {
    const fsp = await import("node:fs/promises");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    Object.defineProperty(process, "platform", { value: "win32" });
    let attempts = 0;
    vi.mocked(fsp.rename).mockImplementation(async (source, destination) => {
      if (String(destination).includes("settings-cache-locks") && readFileSync(source, "utf8") !== "0") {
        attempts++;
        if (attempts <= 3) {
          expect(readFileSync(destination, "utf8")).toBe("0");
          throw Object.assign(new Error("ticket busy fixture"), { code });
        }
      }
      return actual.rename(source, destination);
    });
    expect((await updateSettingsCache({ telemetryOptIn: false })).telemetryOptIn).toBe(false);
    expect(attempts).toBe(4);
    expect((await loadSettingsCache()).telemetryOptIn).toBe(false);
    expect(readdirSync(join(dir, "settings-cache-locks"))).toEqual([]);
  });

  it("stops retrying a permanently busy Windows ticket at the existing deadline", async () => {
    const fsp = await import("node:fs/promises");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
    const failure = Object.assign(new Error("permanently busy ticket fixture"), { code: "EPERM" });
    Object.defineProperty(process, "platform", { value: "win32" });
    let attempts = 0;
    vi.mocked(fsp.rename).mockImplementation(async (source, destination) => {
      if (String(destination).includes("settings-cache-locks") && readFileSync(source, "utf8") !== "0") {
        attempts++;
        expect(readFileSync(destination, "utf8")).toBe("0");
        throw failure;
      }
      return actual.rename(source, destination);
    });
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(2990).mockReturnValueOnce(3000).mockReturnValue(10000);
    try {
      await expect(updateSettingsCache({ telemetryOptIn: false })).rejects.toBe(failure);
    } finally {
      clock.mockRestore();
    }
    expect(attempts).toBe(2);
    expect((await loadSettingsCache()).telemetryOptIn).toBe(true);
    expect(readdirSync(join(dir, "settings-cache-locks"))).toEqual([]);
  }, 10000);

  it.each([
    { platform: "win32", code: "EACCES" },
    { platform: "darwin", code: "EPERM" },
    { platform: "linux", code: "EBUSY" }
  ])("propagates $code on $platform without retrying", async ({ platform, code }) => {
    const fsp = await import("node:fs/promises");
    await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
    vi.mocked(fsp.rename).mockClear();
    const failure = Object.assign(new Error("unrecoverable ticket fixture"), { code });
    Object.defineProperty(process, "platform", { value: platform });
    vi.mocked(fsp.rename).mockRejectedValue(failure);
    await expect(updateSettingsCache({ telemetryOptIn: false })).rejects.toBe(failure);
    expect(fsp.rename).toHaveBeenCalledTimes(1);
    expect((await loadSettingsCache()).telemetryOptIn).toBe(true);
    expect(readdirSync(join(dir, "settings-cache-locks"))).toEqual([]);
  });

  it("returns defaults when file missing", async () => {
    const s = await loadSettingsCache();
    expect(s.enabled).toBe(true);
    expect(s.outputVerbosity).toBe("compact");
    expect(s.telemetryOptIn).toBe(true);
    expect(s.filters.enableAll).toBe(true);
  });

  it("round-trip save then load", async () => {
    await saveSettingsCache({
      enabled: false,
      telemetryOptIn: true,
      outputVerbosity: "compact",
      filters: { enableAll: false, disabled: ["git", "ls"] }
    });
    const s = await loadSettingsCache();
    expect(s.enabled).toBe(false);
    expect(s.telemetryOptIn).toBe(true);
    expect(s.outputVerbosity).toBe("compact");
    expect(s.filters.disabled).toEqual(["git", "ls"]);
  });

  it("falls back to defaults on corrupt JSON", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings-cache.json"), "not-valid-json{");
    const s = await loadSettingsCache();
    expect(s.enabled).toBe(true);
  });

  it("saves via a temp file then rename, never the live file in place", async () => {
    const fsp = await import("node:fs/promises");
    vi.mocked(fsp.writeFile).mockClear();
    await saveSettingsCache({
      enabled: true,
      telemetryOptIn: false,
      outputVerbosity: "compact",
      reducer: "off",
      filters: { enableAll: true, disabled: [] }
    });
    const target = String(vi.mocked(fsp.writeFile).mock.calls[0]![0]);
    expect(target).not.toBe(join(dir, "settings-cache.json"));
    expect(target).toContain("settings-cache.json.tmp");
    const s = await loadSettingsCache();
    expect(s.telemetryOptIn).toBe(false);
    const mode = statSync(join(dir, "settings-cache.json")).mode;
    expect(mode & 0o200).toBe(0o200);
    if (process.platform !== "win32") expect(mode & 0o777).toBe(0o600);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("uses a unique temp path per concurrent writer", async () => {
    const fsp = await import("node:fs/promises");
    vi.mocked(fsp.writeFile).mockClear();
    const s = {
      enabled: true,
      telemetryOptIn: false,
      outputVerbosity: "compact" as const,
      reducer: "off" as const,
      filters: { enableAll: true, disabled: [] }
    };
    await Promise.all([saveSettingsCache(s), saveSettingsCache(s)]);
    const targets = vi.mocked(fsp.writeFile).mock.calls.map((c) => String(c[0]));
    expect(targets).toHaveLength(2);
    expect(new Set(targets).size).toBe(2);
    const loaded = await loadSettingsCache();
    expect(loaded.telemetryOptIn).toBe(false);
  });

  it("merges partial cache with defaults", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings-cache.json"),
      JSON.stringify({ enabled: false })
    );
    const s = await loadSettingsCache();
    expect(s.enabled).toBe(false);
    expect(s.outputVerbosity).toBe("compact");
  });
});
