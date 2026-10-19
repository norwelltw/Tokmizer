import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLauncherScript } from "../shim/launcher";

let root: string;
let home: string;
let cache: string;
let script: string;

function plugin(version: string, nativeOutput: string | null): string {
  const bin = join(cache, version, "dist", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tkr-shim.js"), "");
  writeFileSync(join(bin, "tkr-shim.stable"), "");
  writeFileSync(join(bin, "tkr-exec.js"), "");
  if (nativeOutput !== null) {
    writeFileSync(join(bin, "tkr-exec"), `#!/bin/sh\necho "${nativeOutput} $*"\n`);
    chmodSync(join(bin, "tkr-exec"), 0o755);
  }
  return bin;
}

function run(...args: string[]) {
  return spawnSync("/bin/sh", [script, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", TOKMIZER_HOME: home, HOME: root } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tkr-run-"));
  home = join(root, ".tokmizer");
  cache = join(root, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(cache, { recursive: true });
  process.env.TOKMIZER_HOME = home;
  script = join(root, "tkr-run");
  writeFileSync(script, runLauncherScript({ single: "", js: "", cache, node: "" }));
});

afterEach(() => {
  delete process.env.TOKMIZER_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("tkr-run", () => {
  it("hands the command to the newest installed launcher", () => {
    plugin("0.9.67", "old");
    plugin("0.9.69", "new");
    const r = run("git", "status");
    expect(r.stdout.trim()).toBe("new git status");
  });

  it("runs the original command, exit code included, when no launcher is installed", () => {
    const r = run("sh", "-c", "echo plain; exit 3");
    expect(r.stdout.trim()).toBe("plain");
    expect(r.status).toBe(3);
  });

  it("runs the original command when the install it was written for is gone", () => {
    const bin = plugin("0.9.69", "new");
    rmSync(join(bin, "..", ".."), { recursive: true, force: true });
    plugin("0.9.68", "previous");
    expect(run("git", "status").stdout.trim()).toBe("previous git status");
    rmSync(cache, { recursive: true, force: true });
    const r = run("sh", "-c", "echo plain");
    expect(r.stdout.trim()).toBe("plain");
    expect(r.status).toBe(0);
  });

  it("runs the original command when Tokmizer is set to fail open", () => {
    plugin("0.9.69", "new");
    writeFileSync(join(home, "fail-open"), "");
    expect(run("sh", "-c", "echo plain").stdout.trim()).toBe("plain");
  });

  it("runs the original command exactly once when the installed launcher is empty or broken", () => {
    plugin("0.9.69", null);
    const counter = join(root, "count");
    const r = run("sh", "-c", `echo x >> '${counter}'; exit 1`);
    expect(r.status).toBe(1);
    expect(spawnSync("/bin/sh", ["-c", `wc -l < '${counter}'`], { encoding: "utf8" }).stdout.trim()).toBe("1");
  });
});
