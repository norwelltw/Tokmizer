import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let prevHome: string | undefined;
let prevBin: string | undefined;
let prevXdg: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tkr-cd-"));
  prevHome = process.env.TOKMIZER_HOME;
  prevBin = process.env.TOKMIZER_DAEMON_BIN;
  prevXdg = process.env.XDG_RUNTIME_DIR;
  process.env.TOKMIZER_HOME = workDir;
  process.env.TOKMIZER_DAEMON_BIN = "/bin/true";
  delete process.env.XDG_RUNTIME_DIR;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = prevHome;
  if (prevBin === undefined) delete process.env.TOKMIZER_DAEMON_BIN;
  else process.env.TOKMIZER_DAEMON_BIN = prevBin;
  if (prevXdg !== undefined) process.env.XDG_RUNTIME_DIR = prevXdg;
});

describe("daemon spawn failure cooldown", () => {
  it("records the failure, logs it, and fails fast on the next attempt", async () => {
    const { connectDaemon } = await import("../daemon/client");
    await expect(connectDaemon()).rejects.toThrow();
    expect(existsSync(join(workDir, "daemon.spawn.fail"))).toBe(true);
    expect(readFileSync(join(workDir, "daemon.log"), "utf8")).toContain("spawn");

    const t0 = Date.now();
    await expect(connectDaemon()).rejects.toThrow(/cooldown/);
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 15000);
});
