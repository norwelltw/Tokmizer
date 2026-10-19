import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsCommand } from "../exec/windows-command";

let root: string;
let project: string;
let bin: string;
let other: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tkr-wincmd-"));
  project = join(root, "project");
  bin = join(root, "bin");
  other = join(root, "other");
  for (const d of [project, bin, other]) mkdirSync(d);
  writeFileSync(join(project, "git.cmd"), "@echo planted");
  writeFileSync(join(bin, "git.exe"), "");
  writeFileSync(join(other, "npm.cmd"), "");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = () => ({ Path: [project, bin, other].join(";").replace(project, "."), PATHEXT: ".COM;.EXE;.BAT;.CMD" });

describe("windowsCommand", () => {
  it("finds the command on PATH and never in the project folder", () => {
    expect(windowsCommand("git", env(), project, "win32")).toBe(join(bin, "git.exe"));
  });

  it("skips a PATH entry that points at the project folder", () => {
    expect(windowsCommand("git", { Path: [project, bin].join(";"), PATHEXT: ".EXE;.CMD" }, project, "win32")).toBe(join(bin, "git.exe"));
  });

  it("tries each PATHEXT extension in order", () => {
    expect(windowsCommand("npm", env(), project, "win32")).toBe(join(other, "npm.cmd"));
  });

  it("keeps a command that already names a path", () => {
    expect(windowsCommand("C:\\tools\\git.exe", env(), project, "win32")).toBe("C:\\tools\\git.exe");
    expect(windowsCommand(".\\build.cmd", env(), project, "win32")).toBe(".\\build.cmd");
  });

  it("never leaves a command missing from PATH to a lookup that starts in the project folder", () => {
    writeFileSync(join(project, "pytest.cmd"), "@echo planted");
    const resolved = windowsCommand("pytest", { ...env(), SystemRoot: "C:\\Windows" }, project, "win32");
    expect(resolved).toBe("C:\\Windows\\tkr-not-on-path\\pytest");
  });

  it("finds a dotted name with or without its extension", () => {
    writeFileSync(join(bin, "python3.12.exe"), "");
    writeFileSync(join(bin, "py.test"), "");
    expect(windowsCommand("python3.12", env(), project, "win32")).toBe(join(bin, "python3.12.exe"));
    expect(windowsCommand("py.test", env(), project, "win32")).toBe(join(bin, "py.test"));
  });

  it("does nothing outside Windows", () => {
    expect(windowsCommand("git", env(), project, "darwin")).toBe("git");
  });
});
