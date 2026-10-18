import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_HOSTS, isAgentHost, parseRewriteArgs, rewriteForAgent } from "../agent-rewrite";
import { detectHost, detectHostFromArgv } from "../host-detect";

describe("rewriteForAgent", () => {
  it("routes a command through the exec wrapper and records usage", () => {
    const usage = vi.fn();
    expect(rewriteForAgent("git log && cd /tmp", "opencode", "s1", "tkr-exec", usage)).toBe("tkr-exec git log && cd /tmp");
    expect(usage).toHaveBeenCalledWith("s1", true);
  });

  it("returns null when nothing changes or no exec entrypoint exists", () => {
    const usage = vi.fn();
    expect(rewriteForAgent("cd /tmp", "pi", "s1", "tkr-exec", usage)).toBeNull();
    expect(usage).toHaveBeenCalledWith("s1", false);
    expect(rewriteForAgent("git log", "pi", "s1", null, usage)).toBeNull();
    expect(rewriteForAgent("", "pi", "s1", "tkr-exec", usage)).toBeNull();
  });
});

describe("parseRewriteArgs", () => {
  it("accepts every agent host and an optional session", () => {
    for (const host of AGENT_HOSTS) expect(parseRewriteArgs(["--host", host])).toEqual({ host });
    expect(parseRewriteArgs(["--host", "amp", "--session", "abc"])).toEqual({ host: "amp", session: "abc" });
  });

  it("rejects unknown hosts, missing values and stray arguments", () => {
    expect(parseRewriteArgs([])).toBeNull();
    expect(parseRewriteArgs(["--host"])).toBeNull();
    expect(parseRewriteArgs(["--host", "cursor"])).toBeNull();
    expect(parseRewriteArgs(["--host", "amp", "extra"])).toBeNull();
    expect(isAgentHost("claude-code")).toBe(false);
  });
});

describe("agent host labels", () => {
  it("are accepted through TOKMIZER_HOST and --host", () => {
    for (const host of AGENT_HOSTS) {
      expect(detectHost({ TOKMIZER_HOST: host }).host).toBe(host);
      expect(detectHostFromArgv(["--host", host])).toBe(host);
    }
  });
});

describe("tkr rewrite", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tkr-rewrite-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const run = (args: string[], input: string) =>
    spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/bin/tkr.ts"), "rewrite", ...args], {
      encoding: "utf8",
      input,
      timeout: 10000,
      env: { ...process.env, CI: "1", TOKMIZER_HOME: home, TOKMIZER_BASE_URL: "http://127.0.0.1:1", TOKMIZER_AUTO_UPDATE: "0" }
    });

  it("prints nothing and exits 0 when the command is left as typed", () => {
    const r = run(["--host", "opencode"], "cd /tmp");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("exits 2 with usage on an unknown host", () => {
    const r = run(["--host", "nope"], "git log");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage: tkr rewrite --host");
  });
});
