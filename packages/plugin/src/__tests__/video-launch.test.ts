import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendPathList, BLENDER_GPU_STARTUP, blenderAddsSystemScripts, videoLaunch } from "../video-launch";

let root: string;

function app(name: string, version: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(dir, "Contents", "MacOS", "Blender"), "binary");
  writeFileSync(join(dir, "Contents", "Info.plist"), `<plist><dict>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>`);
  return dir;
}

function binDir(name: string, target: string, wrapper: boolean): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (wrapper) writeFileSync(join(dir, "blender"), `#!/bin/bash\nexec "${target}"  "$@"\n`);
  else symlinkSync(target, join(dir, "blender"));
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tkr-video-launch-"));
  vi.stubEnv("TOKMIZER_HOME", join(root, "home"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("blenderAddsSystemScripts", () => {
  it("accepts Blender 4.2 and later found through a Homebrew wrapper or a symlink", () => {
    const five = app("B5.app", "5.3.0");
    const fourTwo = app("B42.app", "4.2.1");
    const path = [binDir("brew", join(five, "Contents/MacOS/Blender"), true), binDir("link", join(fourTwo, "Contents/MacOS/Blender"), false)].join(delimiter);
    expect(blenderAddsSystemScripts(path, [])).toBe(true);
  });

  it("refuses when any Blender a command could start is older than 4.2: the variable replaced its scripts there", () => {
    const old = app("Old.app", "4.1.1");
    const path = binDir("brew", join(old, "Contents/MacOS/Blender"), true);
    expect(blenderAddsSystemScripts(path, [app("New.app", "5.0.0")])).toBe(false);
  });

  it("checks every Blender*.app it is given, so an old second install keeps the variable away", () => {
    const five = app("Blender.app", "5.3.0");
    const old = app("Blender 3.6.app", "3.6.5");
    expect(blenderAddsSystemScripts(binDir("brew", join(five, "Contents/MacOS/Blender"), true), [five, old])).toBe(false);
  });

  it("refuses without any Blender or with an unreadable version", () => {
    expect(blenderAddsSystemScripts("/nonexistent", [])).toBe(false);
    const broken = app("Broken.app", "x");
    expect(blenderAddsSystemScripts(undefined, [broken])).toBe(false);
  });
});

describe("videoLaunch", () => {
  const darwin = { platform: "darwin" as const, arch: "arm64", enabled: true };

  it("adds the GPU startup scripts for any command and the Cycles device to a plain render", () => {
    const five = app("B5.app", "5.3.0");
    const pathEnv = binDir("brew", join(five, "Contents/MacOS/Blender"), true);
    const script = videoLaunch(["python3", "render.py"], root, { ...darwin, pathEnv });
    expect(script.argv).toEqual(["python3", "render.py"]);
    expect(script.notice).toBe("");
    const dir = script.appendPathEnv.BLENDER_SYSTEM_SCRIPTS!;
    expect(readFileSync(join(dir, "startup", "tkr_cycles_gpu.py"), "utf8")).toBe(BLENDER_GPU_STARTUP);
    const plain = videoLaunch(["blender", "-b", "a.blend", "-f", "1"], root, { ...darwin, pathEnv });
    expect(plain.argv).toEqual(["blender", "-b", "a.blend", "-f", "1", "--", "--cycles-device", "METAL"]);
    expect(plain.notice).toContain("--cycles-device METAL");
  });

  it("leaves commands as written when video mode is off, off Apple Silicon, or Blender is too old", () => {
    const old = app("Old.app", "3.6.0");
    const pathEnv = binDir("brew", join(old, "Contents/MacOS/Blender"), true);
    const argv = ["blender", "-b", "a.blend", "-f", "1"];
    expect(videoLaunch(argv, root, { ...darwin, enabled: false, pathEnv })).toEqual({ argv, notice: "", appendPathEnv: {} });
    expect(videoLaunch(argv, root, { ...darwin, platform: "linux", pathEnv })).toEqual({ argv, notice: "", appendPathEnv: {} });
    expect(videoLaunch(argv, root, { ...darwin, arch: "x64", pathEnv }).appendPathEnv).toEqual({});
    expect(videoLaunch(["python3", "r.py"], root, { ...darwin, pathEnv }).appendPathEnv).toEqual({});
  });
});

describe("BLENDER_GPU_STARTUP", () => {
  it("tracks flipped scenes by pointer and lets a scene opt out", () => {
    expect(BLENDER_GPU_STARTUP).toContain("_flipped.add(scene.as_pointer())");
    expect(BLENDER_GPU_STARTUP).not.toContain("name_full");
    expect(BLENDER_GPU_STARTUP).toContain('scene.get("tkr_keep_device")');
  });
});

describe("appendPathList", () => {
  it("keeps the user's directories first and never duplicates ours", () => {
    expect(appendPathList(undefined, "/t")).toBe("/t");
    expect(appendPathList(`/a${delimiter}/b`, "/t")).toBe(`/a${delimiter}/b${delimiter}/t`);
    expect(appendPathList(`/t${delimiter}/a`, "/t")).toBe(`/t${delimiter}/a`);
  });
});
