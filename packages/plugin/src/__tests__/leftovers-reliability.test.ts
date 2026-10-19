import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { recordSessionEvent, readSessionEvents, sessionFile } from "../session-log";
import { captureForRestore, captureOriginalForRestore } from "../content-cache";
import { exitOnBrokenPipe } from "../epipe";
import { claudeConfigDir } from "../claude-config-dir";
import { claudeSettingsFile } from "../claude-hooks";

// Built at runtime so no token-shaped literal sits in the source.
const FAKE_GH = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-left-"));
  process.env.TOKMIZER_HOME = home;
  delete process.env.TOKMIZER_CCR_DISABLED;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("session-log redaction", () => {
  const cases: Array<[string, string]> = [
    ["curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123' https://x", "sk-abcdefghijkl"],
    [`export GITHUB_TOKEN=${FAKE_GH}`, "ghp_abcdefghijkl"],
    ["mysql -u root -pSUPERSECRET db", "SUPERSECRET"],
    ["mysql -pSUPERSECRET", "SUPERSECRET"]
  ];
  for (const [cmd, secret] of cases) {
    it(`does not store the secret in: ${cmd.slice(0, 30)}`, () => {
      recordSessionEvent("s1", { tool: "Bash", target: cmd });
      expect(readFileSync(sessionFile("s1"), "utf8")).not.toContain(secret);
      expect(readSessionEvents("s1")[0]!.target).toContain("REDACTED");
    });
  }

  it("keeps harmless commands and `mkdir -p`", () => {
    recordSessionEvent("s2", { tool: "Bash", target: "mkdir -p /tmp/x && npm test" });
    expect(readSessionEvents("s2")[0]!.target).toBe("mkdir -p /tmp/x && npm test");
  });

  it("redacts before truncating so a cut cannot leave a token prefix", () => {
    recordSessionEvent("s3", { tool: "Bash", target: `${"a ".repeat(55)}export GITHUB_TOKEN=${FAKE_GH}` });
    expect(readFileSync(sessionFile("s3"), "utf8")).not.toContain("ghp_abc");
  });
});

describe("content-cache oversize note", () => {
  const big = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");

  it("says the output was too large when the original exceeds the entry limit", async () => {
    const env = { ...process.env, TOKMIZER_CCR_ENTRY_MAX_BYTES: "1000" };
    const out = await captureOriginalForRestore(big, "head\n… (190 more lines omitted)", env);
    expect(out).toContain("too large to keep");
    expect(out).toContain("no restore available");
    expect(out).not.toMatch(/\[tkr restore [0-9a-f]+\]/);
    const out2 = await captureForRestore(big, "head\n… (190 more lines omitted)", env, { raw: big });
    expect(out2).toContain("too large to keep");
  });

  it("still gives a restore pointer under the limit", async () => {
    const out = await captureOriginalForRestore(big, "head", process.env);
    expect(out).toMatch(/\[tkr restore [0-9a-f]{16}\]/);
  });
});

describe("epipe", () => {
  it("never throws on a non-EPIPE error (command exit code preserved)", () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitOnBrokenPipe(stream, exit, () => {});
    expect(() => stream.emit("error", Object.assign(new Error("x"), { code: "ENOSPC" }))).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("CLAUDE_CONFIG_DIR resolution", () => {
  it("expands a leading tilde", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "~/.claude-work" }, "/opt/u")).toBe("/opt/u/.claude-work");
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "~" }, "/opt/u")).toBe("/opt/u");
  });
  it("resolves relative paths and normalizes", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "rel/dir" }, "/opt/u")).toBe(resolve("rel/dir"));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/a/b/../c" }, "/opt/u")).toBe("/a/c");
  });
  it("falls back to ~/.claude when unset or blank", () => {
    expect(claudeConfigDir({}, "/opt/u")).toBe("/opt/u/.claude");
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "  " }, "/opt/u")).toBe("/opt/u/.claude");
  });
  it("is used by claudeSettingsFile", () => {
    process.env.CLAUDE_CONFIG_DIR = "~/.claude-work";
    expect(claudeSettingsFile()).toBe(join(homedir(), ".claude-work", "settings.json"));
  });
});
