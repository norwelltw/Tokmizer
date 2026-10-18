import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { socketPath, cleanupStaleSocket, isParentAlive } from "../daemon/lifecycle";

let dir: string;
let origXdg: string | undefined;
let origHome: string | undefined;
const cleanupDirs = new Set<string>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-life-"));
  origXdg = process.env.XDG_RUNTIME_DIR;
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = join(dir, "home");
  process.env.XDG_RUNTIME_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const path of cleanupDirs) rmSync(path, { recursive: true, force: true });
  cleanupDirs.clear();
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  if (origXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = origXdg;
});

describe("lifecycle", () => {
  it("does not use a runtime directory writable by another user", () => {
    if (process.platform === "win32") return;
    chmodSync(dir, 0o777);
    expect(dirname(socketPath().path)).not.toBe(dir);
  });
  it("socketPath uses tmpdir or XDG dir on Unix, pipe on Windows", () => {
    const r = socketPath();
    if (process.platform === "win32") {
      expect(r.path).toContain("\\\\.\\pipe\\tokmizer-");
      expect(r.isPipe).toBe(true);
    } else {
      expect(r.isPipe).toBe(false);
      expect(r.path).toMatch(/tokmizer-\d+\.sock$/);
    }
  });

  it("cleanupStaleSocket removes a stale plain file", async () => {
    if (process.platform === "win32") return;
    const { path } = socketPath();
    writeFileSync(path, "stale");
    await cleanupStaleSocket();
    expect(existsSync(path)).toBe(true);
  });

  it("isParentAlive returns boolean without throwing", () => {
    expect(typeof isParentAlive()).toBe("boolean");
  });
});

describe("socketPath length guard", () => {
  it("falls back to a short tmpdir socket when the home path would exceed sun_path", async () => {
    const prevHome = process.env.TOKMIZER_HOME;
    const prevXdg = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    process.env.TOKMIZER_HOME = join(dir, "very-long-segment/".repeat(8), "home");
    try {
      const { socketPath } = await import("../daemon/lifecycle");
      const { path, isPipe } = socketPath();
      if (process.platform !== "win32") {
        expect(isPipe).toBe(false);
        expect(path.length).toBeLessThanOrEqual(104);
        expect(path.endsWith(".sock")).toBe(true);
        const parent = statSync(dirname(path));
        expect(parent.mode & 0o777).toBe(0o700);
        expect(parent.uid).toBe(process.getuid!());
        cleanupDirs.add(dirname(path));
      }
    } finally {
      if (prevHome === undefined) delete process.env.TOKMIZER_HOME;
      else process.env.TOKMIZER_HOME = prevHome;
      if (prevXdg !== undefined) process.env.XDG_RUNTIME_DIR = prevXdg;
    }
  });
});
