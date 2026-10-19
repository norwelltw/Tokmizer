import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requirements = vi.hoisted(() => ({ path: process.platform === "win32" ? "" : "/etc/codex/requirements.toml", content: null as string | null, error: null as string | null }));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (file === requirements.path) {
      if (requirements.error) throw Object.assign(new Error(requirements.error), { code: requirements.error });
      if (requirements.content === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return requirements.content;
    }
    return (fs.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

const { buildPreToolUseOutput } = await import("../hooks-host/pre-tool-use");

const p = (command: string) => ({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "s-req", tool_input: { command } });
let home: string;
let bin: string;
let programData: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-codex-req-home-"));
  bin = mkdtempSync(join(tmpdir(), "tkr-codex-req-bin-"));
  programData = mkdtempSync(join(tmpdir(), "tkr-codex-req-pd-"));
  for (const name of ["rm", "git", "cat"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\n");
    chmodSync(join(bin, name), 0o755);
  }
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("ProgramData", programData);
  if (process.platform === "win32") requirements.path = join(programData, "OpenAI", "Codex", "requirements.toml");
  requirements.content = null;
  requirements.error = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of [home, bin, programData]) rmSync(dir, { recursive: true, force: true });
});

const rewritten = (command: string): boolean => buildPreToolUseOutput(p(command), "codex", "tkr-exec", () => {}, {}, bin) !== null;

describe("Codex rewrite respects administrator requirements", () => {
  it("does not approve a command a prompt or forbidden requirement covers", () => {
    requirements.content = [
      "[rules]",
      "prefix_rules = [",
      "  { pattern = [{ token = \"rm\" }], decision = \"forbidden\", justification = \"Use git clean -fd instead.\" },",
      "  { pattern = [{ token = \"git\" }, { any_of = [\"push\", \"log\"] }], decision = \"prompt\" },",
      "]"
    ].join("\n");
    for (const c of ["rm notes.txt", "git log -n 3", "cd /x && git log"]) expect(rewritten(c), c).toBe(false);
    for (const c of ["cat a.md", "git diff"]) expect(rewritten(c), c).toBe(true);
  });

  it("keeps rewriting when the file is absent or has no command rules", () => {
    expect(rewritten("git log -n 3")).toBe(true);
    requirements.content = "allowed_approval_policies = [\"on-request\"]\n";
    expect(rewritten("git log -n 3")).toBe(true);
  });

  it("does not approve anything when the requirements cannot be understood", () => {
    for (const content of [
      "[rules\nprefix_rules = []",
      "[rules]\nprefix_rules = [{ pattern = [{ token = \"rm\" }], decision = \"allow\" }]",
      "[rules]\nprefix_rules = [{ pattern = [{ regex = \"rm\" }], decision = \"forbidden\" }]",
      "[rules]\nprefix_rules = [{ pattern = [{ token = \"rm\" }] }]"
    ]) {
      requirements.content = content;
      expect(rewritten("cat a.md"), content).toBe(false);
    }
    requirements.content = null;
    requirements.error = "EACCES";
    expect(rewritten("cat a.md")).toBe(false);
  });
});
