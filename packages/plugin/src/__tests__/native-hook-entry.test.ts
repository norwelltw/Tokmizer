import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exists, usable } = vi.hoisted(() => ({ exists: vi.fn(), usable: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: exists }));
vi.mock("../hooks-host/exec-health", () => ({ execUsable: usable }));
import { execInvocation, rewrite } from "../hooks-host/pre-tool-rewrite";

beforeEach(() => usable.mockReturnValue(true));
afterEach(() => vi.resetAllMocks());

describe("installed hook entrypoint", () => {
  it("does not rewrite through an installed launcher that cannot run on this machine", () => {
    exists.mockReturnValue(true);
    usable.mockReturnValue(false);
    expect(execInvocation("claude-code", "darwin")).toBeNull();
    expect(execInvocation("cursor", "linux")).toBeNull();
    expect(execInvocation("claude-code", "win32")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("selects the installed executable without a Node process", () => {
    exists.mockReturnValue(true);
    expect(execInvocation()).toMatch(/^'.*\/bin\/tkr-exec'$/);
  });

  it.skipIf(process.platform === "win32")("labels Cursor and Gemini runs through an explicit host prefix", () => {
    exists.mockReturnValue(true);
    expect(execInvocation("cursor")).toMatch(/^TOKMIZER_HOST=cursor '.*\/bin\/tkr-exec'$/);
    expect(execInvocation("gemini-cli")).toMatch(/^TOKMIZER_HOST=gemini-cli '.*\/bin\/tkr-exec'$/);
    for (const host of ["copilot", "droid", "trae", "qwen-code", "crush", "junie"] as const) {
      expect(execInvocation(host)).toMatch(new RegExp(`^TOKMIZER_HOST=${host} '.*/bin/tkr-exec'$`));
    }
    expect(execInvocation("claude-code")).toMatch(/^'.*\/bin\/tkr-exec'$/);
    expect(execInvocation("codex")).toMatch(/^'.*\/bin\/tkr-exec'$/);
  });

  it("selects the Windows launcher with forward slashes for Claude Code only", () => {
    exists.mockImplementation((path: string) => path.endsWith("tkr-exec.exe") || path.endsWith("tkr-exec.js"));
    expect(execInvocation(undefined, "win32")).toMatch(/^'[^\\]*\/bin\/tkr-exec\.exe'$/);
    expect(execInvocation("claude-code", "win32")).toMatch(/\/bin\/tkr-exec\.exe'$/);
    expect(execInvocation("codex", "win32")).toMatch(/^node '.*tkr-exec\.js'$/);
    expect(execInvocation("cursor", "win32")).toMatch(/^node '.*tkr-exec\.js'$/);
  });

  it("keeps Windows on Node when the launcher is not installed", () => {
    exists.mockImplementation((path: string) => path.endsWith("tkr-exec.js"));
    expect(execInvocation(undefined, "win32")).toMatch(/^node '.*tkr-exec\.js'$/);
  });

  it("does not wrap a host-prefixed entrypoint a second time", () => {
    const executable = "TOKMIZER_HOST=cursor '/tmp/package space/dist/bin/tkr-exec'";
    const command = rewrite("git status && cat file", executable);
    expect(command).toBe(`${executable} git status && ${executable} cat file`);
    expect(rewrite(command, executable)).toBe(command);
  });

  it("keeps the explicit Node fallback for older packages", () => {
    exists.mockImplementation((path: string) => path.endsWith("tkr-exec.js"));
    expect(execInvocation()).toMatch(/^node '.*tkr-exec\.js'$/);
  });

  it("returns no entrypoint when neither executable exists", () => {
    exists.mockReturnValue(false);
    expect(execInvocation()).toBeNull();
  });

  it("does not wrap its absolute quoted entrypoint a second time", () => {
    const executable = "'/tmp/package space/dist/bin/tkr-exec'";
    const command = rewrite("git status && cat file", executable);
    expect(rewrite(command, executable)).toBe(command);
    expect(rewrite(`${executable}-other cat file`, executable)).toBe(`${executable} ${executable}-other cat file`);
  });
});
