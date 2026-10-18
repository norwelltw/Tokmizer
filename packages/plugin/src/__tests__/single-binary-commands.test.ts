import { afterEach, describe, expect, it, vi } from "vitest";
import { hookCommandFor } from "../hook-config";
import { windowsWrapperScript } from "../shim/install";
import { hookLauncherFile, hookLauncherScript, launchTargetFor, launcherScript, readLauncher } from "../shim/launcher";

const stableHook = (mark: string): string => `[ ! -f '${hookLauncherFile()}' ] || exec /bin/sh '${hookLauncherFile()}' ${mark}`;
import { tkrArgv } from "../agent-shim-files";
import { agentHookCommand } from "../agent-command-hooks";
import { execInvocation, rewrite } from "../hooks-host/pre-tool-rewrite";

afterEach(() => {
  vi.unstubAllEnvs();
});

const self = `'${process.execPath.replace(/'/g, "'\\''")}'`;

describe("commands written by the single binary", () => {
  it("keeps the Node forms when running from the npm scripts", () => {
    expect(hookCommandFor("tkr-codex-hook", "/nonexistent", "/pkg/dist/bin/tkr-codex-hook.js")).toBe(stableHook("tkr-codex-hook"));
    expect(readLauncher(hookLauncherFile())?.target).toMatchObject({ single: "", js: "/pkg/dist/bin/tkr-shim.js" });
    expect(launchTargetFor("/pkg/dist/bin/tkr-shim.js")).toMatchObject({ single: "", js: "/pkg/dist/bin/tkr-shim.js" });
    expect(windowsWrapperScript("C:\\pkg\\dist\\bin\\tkr-shim.js", "git")).toContain('node "C:\\pkg\\dist\\bin\\tkr-shim.js" --as "git" %*');
  });

  it("points agent hooks at the executable entry instead of node", () => {
    vi.stubEnv("TOKMIZER_SINGLE_BINARY", "1");
    expect(hookCommandFor("tkr-codex-hook", "/nonexistent", "/$bunfs/dist/bin/tkr-codex-hook.js")).toBe(stableHook("tkr-codex-hook"));
    expect(hookCommandFor("tkr-copilot-hook", "/nonexistent", "/$bunfs/dist/bin/tkr-copilot-hook.js")).toBe(stableHook("tkr-copilot-hook"));
    expect(agentHookCommand("vibe", "/nonexistent", "/$bunfs/dist/bin/tkr-agent-hook.js")).toBe(`${stableHook("tkr-agent-hook")} vibe`);
    expect(readLauncher(hookLauncherFile())?.target).toMatchObject({ single: process.execPath, js: "" });
    expect(hookLauncherScript(readLauncher(hookLauncherFile())!.target)).toContain('exec "$_tk_s" hook "${_tk_w%-hook}" "$@"');
  });

  it("makes shell shims and agent shims re-enter the executable", () => {
    vi.stubEnv("TOKMIZER_SINGLE_BINARY", "1");
    vi.stubEnv("PATH", "/nonexistent");
    expect(launchTargetFor("/$bunfs/dist/bin/tkr-shim.js")).toMatchObject({ single: process.execPath, js: "" });
    expect(launcherScript(launchTargetFor("/$bunfs/dist/bin/tkr-shim.js"))).toContain(`exec "$_tk_s" shim-run --as "$_tk_c" "$@"`);
    expect(launchTargetFor("/custom/runner.js")).toMatchObject({ single: "", js: "/custom/runner.js" });
    expect(windowsWrapperScript("B:/~BUN/root/dist/bin/tkr-shim.js", "git")).toContain(`"${process.execPath}" shim-run --as "git" %*`);
    expect(tkrArgv("/nonexistent", "/$bunfs/dist/bin/tkr.js", "darwin")).toEqual([process.execPath]);
    expect(tkrArgv("", "B:/~BUN/root/dist/bin/tkr.js", "win32")).toEqual([process.execPath]);
  });

  it("rewrites agent commands through the executable when no native launcher sits beside it", () => {
    vi.stubEnv("TOKMIZER_SINGLE_BINARY", "1");
    const exec = execInvocation("cursor", "darwin");
    expect(exec).toBe(`TOKMIZER_HOST=cursor ${self} exec`);
    expect(execInvocation("claude-code", "win32")).toBe(`'${process.execPath.replace(/\\/g, "/")}' exec`);
    expect(rewrite("git status", exec!)).toBe(`${exec} git status`);
    expect(rewrite(`${exec} git status`, exec!)).toBe(`${exec} git status`);
  });
});
