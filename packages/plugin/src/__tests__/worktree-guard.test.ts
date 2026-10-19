import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteShellDecision } from "../hooks-host/pre-tool-rewrite";

let root: string;
let config: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-worktree-guard-")));
  config = join(root, "config");
  mkdirSync(config);
  writeFileSync(join(config, "settings.json"), "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function decide(cmd: string, cwd: string) {
  return rewriteShellDecision(cmd, { host: "claude-code", sessionId: "s", cwd, claudeDirs: { configDir: config }, pathEnv: "/usr/bin:/bin", permissionMode: "bypassPermissions" }, "tkr-exec", () => {})?.command ?? null;
}

describe("Claude Code worktree isolation", () => {
  it("leaves segments with a git word as typed inside a linked worktree", () => {
    const wt = join(root, "wt", "sub");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    expect(decide("git status", wt)).toBeNull();
    expect(decide("grep -n git README.md", wt)).toBeNull();
    expect(decide("git log -n 3 && ls -la", wt)).toBe("git log -n 3 && tkr-exec ls -la");
    expect(decide("ls -la", wt)).toBe("tkr-exec ls -la");
  });

  it("still rewrites git in a regular checkout", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(decide("git status", repo)).toBe("tkr-exec git status");
    expect(decide("grep -n git README.md", repo)).toBe("tkr-exec grep -n git README.md");
  });
});
