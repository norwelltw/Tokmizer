import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLongRunningInvocation, resolveStreamAfterMs, runShim } from "../shim/runner";

let dir: string;
let origHome: string | undefined;
let origStreamAfter: string | undefined;
let origTimeout: string | undefined;

vi.mock("../learn/recorder", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../learn/telemetry", () => ({
  recordTelemetry: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stats")>();
  return { ...actual, recordStat: vi.fn() };
});
vi.mock("../daemon/resolver", () => ({
  installDaemonResolver: vi.fn(),
  closeDaemonResolver: vi.fn()
}));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-shim-stream-"));
  origHome = process.env.TOKMIZER_HOME;
  origStreamAfter = process.env.TOKMIZER_SHIM_STREAM_AFTER_MS;
  origTimeout = process.env.TOKMIZER_SHIM_TIMEOUT_MS;
  process.env.TOKMIZER_HOME = dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      token: "t",
      plan: "smart",
      email: "x@y",
      jwt: "j",
      jwtExp: Date.now() + 60_000,
      pluginVersion: "0.1.0",
      installId: "11111111-1111-1111-1111-111111111111",
      status: "active"
    })
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ["TOKMIZER_HOME", origHome],
    ["TOKMIZER_SHIM_STREAM_AFTER_MS", origStreamAfter],
    ["TOKMIZER_SHIM_TIMEOUT_MS", origTimeout]
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

function captureStdout(): { text: () => string; restore: () => void } {
  const orig = process.stdout.write.bind(process.stdout);
  const chunks: Buffer[] = [];
  process.stdout.write = ((c: string | Buffer) => {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    restore: () => {
      process.stdout.write = orig;
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("isLongRunningInvocation", () => {
  it("flags dev-server scripts across js package managers", () => {
    expect(isLongRunningInvocation("pnpm", ["run", "dev"])).toBe(true);
    expect(isLongRunningInvocation("npm", ["run", "dev"])).toBe(true);
    expect(isLongRunningInvocation("yarn", ["dev"])).toBe(true);
    expect(isLongRunningInvocation("pnpm", ["dev"])).toBe(true);
    expect(isLongRunningInvocation("npm", ["start"])).toBe(true);
    expect(isLongRunningInvocation("pnpm", ["run", "serve"])).toBe(true);
    expect(isLongRunningInvocation("npm", ["run", "watch"])).toBe(true);
  });

  it("ignores flags when locating the script name", () => {
    expect(isLongRunningInvocation("pnpm", ["--filter", "web", "run", "dev"])).toBe(true);
    expect(isLongRunningInvocation("npm", ["run", "--silent", "dev"])).toBe(true);
  });

  it("leaves one-shot commands on the compressed path", () => {
    expect(isLongRunningInvocation("npm", ["run", "build"])).toBe(false);
    expect(isLongRunningInvocation("npm", ["install"])).toBe(false);
    expect(isLongRunningInvocation("pnpm", ["run", "dev:setup"])).toBe(false);
    expect(isLongRunningInvocation("git", ["status"])).toBe(false);
    expect(isLongRunningInvocation("ls", ["dev"])).toBe(false);
    expect(isLongRunningInvocation("pnpm", [])).toBe(false);
  });
});

describe("resolveStreamAfterMs", () => {
  function withTTY<T>(isTTY: boolean, fn: () => T): T {
    const orig = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: orig, configurable: true });
    }
  }

  it("stays off when stdout is captured, so agent output keeps compressing", () => {
    delete process.env.TOKMIZER_SHIM_STREAM_AFTER_MS;
    expect(withTTY(false, resolveStreamAfterMs)).toBe(0);
  });

  it("is on by default in a live terminal", () => {
    delete process.env.TOKMIZER_SHIM_STREAM_AFTER_MS;
    expect(withTTY(true, resolveStreamAfterMs)).toBe(1500);
  });

  it("honours an explicit override in both cases", () => {
    process.env.TOKMIZER_SHIM_STREAM_AFTER_MS = "250";
    expect(withTTY(false, resolveStreamAfterMs)).toBe(250);
    expect(withTTY(true, resolveStreamAfterMs)).toBe(250);
  });
});

describe("runShim streaming fallback", () => {
  it("releases output while the child is still running", async () => {
    process.env.TOKMIZER_SHIM_STREAM_AFTER_MS = "150";
    const cap = captureStdout();
    let settled = false;
    try {
      const run = runShim({
        cmdName: "/bin/sh",
        args: ["-c", "printf 'server running on :4321\\n'; sleep 2"]
      }).then((r) => {
        settled = true;
        return r;
      });

      let seen = "";
      for (let i = 0; i < 40 && !seen.includes("server running"); i += 1) {
        await sleep(50);
        seen = cap.text();
      }

      expect(seen).toContain("server running on :4321");
      expect(settled).toBe(false);

      const r = await run;
      expect(r.exitCode).toBe(0);
    } finally {
      cap.restore();
    }
  }, 15_000);

  it("does not duplicate the flushed output when the child exits", async () => {
    process.env.TOKMIZER_SHIM_STREAM_AFTER_MS = "150";
    const cap = captureStdout();
    try {
      await runShim({
        cmdName: "/bin/sh",
        args: ["-c", "printf 'once\\n'; sleep 1"]
      });
      const out = cap.text();
      expect(out.match(/once/g)?.length).toBe(1);
    } finally {
      cap.restore();
    }
  }, 15_000);

  it("disarms the hard timeout once the child is streaming", async () => {
    process.env.TOKMIZER_SHIM_STREAM_AFTER_MS = "100";
    process.env.TOKMIZER_SHIM_TIMEOUT_MS = "400";
    const cap = captureStdout();
    try {
      const r = await runShim({
        cmdName: "/bin/sh",
        args: ["-c", "printf 'up\\n'; sleep 1.5"]
      });
      expect(r.exitCode).toBe(0);
    } finally {
      cap.restore();
    }
  }, 15_000);

  it("still kills a silent child that never reaches streaming mode", async () => {
    process.env.TOKMIZER_SHIM_STREAM_AFTER_MS = "0";
    process.env.TOKMIZER_SHIM_TIMEOUT_MS = "300";
    const r = await runShim({ cmdName: "/bin/sh", args: ["-c", "sleep 5"] });
    expect(r.exitCode).toBe(143);
  }, 15_000);

  it("keeps buffering a slow captured command instead of flushing it early", async () => {
    delete process.env.TOKMIZER_SHIM_STREAM_AFTER_MS;
    const cap = captureStdout();
    let settled = false;
    try {
      const run = runShim({
        cmdName: "/bin/sh",
        args: ["-c", "printf 'resolving\\n'; sleep 2.2"]
      }).then((r) => {
        settled = true;
        return r;
      });
      await sleep(1900);
      expect(cap.text()).toBe("");
      expect(settled).toBe(false);
      await run;
      expect(cap.text()).toContain("resolving");
    } finally {
      cap.restore();
    }
  }, 15_000);

  it("keeps buffering short commands so they stay compressible", async () => {
    const cap = captureStdout();
    let settled = false;
    try {
      const run = runShim({ cmdName: "/bin/echo", args: ["quick"] }).then((r) => {
        settled = true;
        return r;
      });
      expect(cap.text()).toBe("");
      await run;
      expect(settled).toBe(true);
      expect(cap.text()).toContain("quick");
    } finally {
      cap.restore();
    }
  });
});
