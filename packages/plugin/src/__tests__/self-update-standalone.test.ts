import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawned: Array<{ cmd: string; args: string[] }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return { on: () => undefined, unref: () => undefined };
    }
  };
});

import { maybeSpawnSelfUpdate, selfUpdate, type RunResult, type SelfUpdateDeps } from "../self-update";

const KEY = "darwin-arm64";
const BASE = "https://downloads.test/v";

let home: string;
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tok-su-sa-"));
  root = join(home, "share", "tokmizer");
  saved = {
    TOKMIZER_HOME: process.env.TOKMIZER_HOME,
    TOKMIZER_AUTO_UPDATE: process.env.TOKMIZER_AUTO_UPDATE,
    TOKMIZER_NETWORK: process.env.TOKMIZER_NETWORK,
    TOKMIZER_SINGLE_BINARY: process.env.TOKMIZER_SINGLE_BINARY,
    TOKMIZER_SELF_UPDATE_CHILD: process.env.TOKMIZER_SELF_UPDATE_CHILD
  };
  process.env.TOKMIZER_HOME = join(home, "tokmizer-home");
  mkdirSync(process.env.TOKMIZER_HOME, { recursive: true });
  delete process.env.TOKMIZER_AUTO_UPDATE;
  delete process.env.TOKMIZER_NETWORK;
  delete process.env.TOKMIZER_SINGLE_BINARY;
  spawned.length = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function versionDir(parent: string, version: string, probeOutput: string): string {
  const dir = join(parent, `tokmizer-${version}-${KEY}`);
  mkdirSync(join(dir, "dist", "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@tokmizer/standalone", version }));
  writeFileSync(join(dir, "dist", "bin", "tkr"), `#!/bin/sh\nprintf '%s\\n' '${probeOutput}'\n`, { mode: 0o755 });
  return dir;
}

function installed(version: string): void {
  versionDir(root, version, `tokmizer-single ${version}`);
  symlinkSync(`tokmizer-${version}-${KEY}`, join(root, "current"));
}

function release(version: string, probeOutput = `tokmizer-single ${version}`, badSum = false): Map<string, Buffer> {
  const stage = mkdtempSync(join(home, "stage-"));
  versionDir(stage, version, probeOutput);
  const name = `tokmizer-${version}-${KEY}`;
  const archive = join(home, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", stage, name]);
  const bytes = readFileSync(archive);
  const sum = badSum ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
  return new Map([
    [`${BASE}${version}/SHA256SUMS`, Buffer.from(`${"f".repeat(64)}  tokmizer-${version}-linux-x64.tar.gz\n${sum}  ${name}.tar.gz\n`)],
    [`${BASE}${version}/${name}.tar.gz`, bytes]
  ]);
}

function realRun(calls: Array<{ cmd: string; args: string[] }>) {
  return async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push({ cmd, args });
    if (cmd === "npm" || cmd === "brew") return { code: 1, stdout: "" };
    if (cmd === "tkr") return { code: 0, stdout: "" };
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

function deps(files: Map<string, Buffer>, latest = "0.9.34") {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fetched: string[] = [];
  const d: SelfUpdateDeps = {
    latest,
    run: realRun(calls),
    npmVersion: () => undefined,
    writable: () => true,
    codexInstalled: () => false,
    ensureCodexHook: async () => "added",
    standalone: {
      root,
      key: KEY,
      base: (v) => `${BASE}${v}`,
      fetch: async (url) => {
        fetched.push(url);
        const body = files.get(url);
        return body ? new Response(new Uint8Array(body)) : new Response("missing", { status: 404 });
      }
    }
  };
  writeFileSync(join(process.env.TOKMIZER_HOME!, "self-update-seen"), JSON.stringify({ version: latest, at: 0 }));
  return { d, calls, fetched };
}

const currentTarget = (): string => readlinkSync(join(root, "current"));

describe("selfUpdate for the standalone binary", () => {
  it("downloads, verifies, probes, then switches current and keeps the previous version", async () => {
    versionDir(root, "0.9.31", "tokmizer-single 0.9.31");
    installed("0.9.33");
    const { d, calls } = deps(release("0.9.34"));
    const actions = await selfUpdate(d);
    expect(actions).toContain("standalone 0.9.33 -> 0.9.34");
    expect(currentTarget()).toBe(`tokmizer-0.9.34-${KEY}`);
    expect(JSON.parse(readFileSync(join(root, "current", "package.json"), "utf8")).version).toBe("0.9.34");
    expect(existsSync(join(root, `tokmizer-0.9.33-${KEY}`, "dist", "bin", "tkr"))).toBe(true);
    expect(existsSync(join(root, `tokmizer-0.9.31-${KEY}`))).toBe(false);
    expect(calls).toContainEqual({ cmd: "tkr", args: ["shims-refresh"] });
    expect(readFileSync(join(process.env.TOKMIZER_HOME!, "self-update.log"), "utf8")).toContain("standalone 0.9.33 -> 0.9.34");
  });

  it("changes nothing when the checksum does not match", async () => {
    installed("0.9.33");
    const { d } = deps(release("0.9.34", undefined, true));
    const actions = await selfUpdate(d);
    expect(actions.some((a) => a.startsWith("standalone failed"))).toBe(true);
    expect(currentTarget()).toBe(`tokmizer-0.9.33-${KEY}`);
    expect(existsSync(join(root, `tokmizer-0.9.34-${KEY}`))).toBe(false);
  });

  it("changes nothing when the new binary fails its probe", async () => {
    installed("0.9.33");
    const { d } = deps(release("0.9.34", "tokmizer-single 0.9.33"));
    const actions = await selfUpdate(d);
    expect(actions.some((a) => a.startsWith("standalone failed"))).toBe(true);
    expect(currentTarget()).toBe(`tokmizer-0.9.33-${KEY}`);
    expect(existsSync(join(root, `tokmizer-0.9.34-${KEY}`))).toBe(false);
  });

  it("makes no request when the network is off", async () => {
    installed("0.9.33");
    process.env.TOKMIZER_NETWORK = "0";
    const { d, fetched } = deps(release("0.9.34"));
    expect(await selfUpdate(d)).toEqual(["network off"]);
    expect(fetched).toHaveLength(0);
    expect(currentTarget()).toBe(`tokmizer-0.9.33-${KEY}`);
  });

  it("never goes back to an older or equal version", async () => {
    installed("0.9.40");
    const { d, fetched } = deps(release("0.9.34"));
    await selfUpdate(d);
    expect(fetched).toHaveLength(0);
    expect(currentTarget()).toBe(`tokmizer-0.9.40-${KEY}`);
  });

  it("does nothing when automatic updates are off", async () => {
    installed("0.9.33");
    process.env.TOKMIZER_AUTO_UPDATE = "0";
    const { d, fetched } = deps(release("0.9.34"));
    expect(await selfUpdate(d)).toEqual(["disabled"]);
    expect(fetched).toHaveLength(0);
  });
});

describe("maybeSpawnSelfUpdate in the standalone binary", () => {
  it("starts the self-update from the binary itself", () => {
    process.env.TOKMIZER_SINGLE_BINARY = "1";
    maybeSpawnSelfUpdate();
    expect(spawned).toEqual([{ cmd: process.execPath, args: ["self-update"] }]);
  });
});
