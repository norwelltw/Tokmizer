import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postToolUseResponse, processToolOutput } from "../hooks-host/post-tool-process";
import { readContentCache } from "../content-cache";
import { FilterDef } from "../engine/schema";
import type { FilterResolver } from "../engine";

const CLAUDE_CAP = 30_000;
const rows = Array.from({ length: 4000 }, (_, i) => `row data value with some padding ${i + 1}`).join("\n") + "\n";

let root: string;
let home: string;
let results: string;

function persist(content: string, name = "full.txt", dir = results): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function bash(command: string, full: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: "sess",
    cwd: root,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "d" },
    tool_response: {
      stdout: full.slice(0, CLAUDE_CAP),
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      persistedOutputPath: persist(full),
      persistedOutputSize: Buffer.byteLength(full, "utf8"),
      ...extra
    }
  };
}

function statRows(): Array<{ r: number; f: number }> {
  const file = join(home, ".tokmizer", "stats.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function restoreHash(output: string): string {
  const hash = /\[tkr restore ([0-9a-f]{8,64})\]$/.exec(output)?.[1];
  expect(hash).toBeDefined();
  return hash!;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-persisted-")));
  home = join(root, "home");
  results = join(root, "projects", "p", "s", "tool-results");
  mkdirSync(home, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.stubEnv("TOKMIZER_HOME", join(home, ".tokmizer"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("Claude Code persisted Bash output", () => {
  for (const command of ["cat big.txt", "cat big.txt; true"]) {
    it(`compresses the full persisted output and restores every byte (${command})`, async () => {
      const envelope = JSON.parse(await postToolUseResponse(bash(command, rows)));
      const updated = envelope.hookSpecificOutput.updatedToolOutput;
      expect(updated.persistedOutputPath).toBeUndefined();
      expect(updated.persistedOutputSize).toBeUndefined();
      expect(updated.stdout.length).toBeLessThanOrEqual(25_000);
      expect(updated.stdout).toContain("row data value with some padding 1\n");
      expect(updated.stdout).toMatch(/padding 4000\n|more lines omitted/);
      expect(await readContentCache(restoreHash(updated.stdout))).toBe(rows);
      expect(statRows()).toHaveLength(1);
      expect(statRows()[0]!.r).toBe(Buffer.byteLength(rows, "utf8"));
    });
  }

  it("leaves the output untouched when the compressed full text stays above 25 000 characters", async () => {
    const full = Array.from({ length: 6000 }, (_, i) => (i % 2 ? `drop ${i}` : `keep line ${i} with enough text to stay large`)).join("\n") + "\n";
    const definition = FilterDef.parse({ slug: "half", match_command: ".*", strip_lines_matching: ["^drop "], max_lines: 100000, scale_with_level: false });
    const resolver: FilterResolver = async () => ({ ...definition, matchRegex: /.*/ });
    for (const command of ["cat big.txt", "cat big.txt; true"]) {
      expect(await processToolOutput(bash(command, full), { resolver })).toBeNull();
    }
    expect(statRows()).toHaveLength(0);
  });

  it("leaves the output untouched when stderr is present or the run was interrupted", async () => {
    for (const extra of [{ stderr: "cat: nosuchfile: No such file or directory" }, { interrupted: true }, { isImage: true }]) {
      expect(await postToolUseResponse(bash("cat big.txt", rows, extra))).toBe("");
    }
    expect(statRows()).toHaveLength(0);
  });

  it("leaves the output untouched when the persisted file is missing, unsafe or does not match", async () => {
    const elsewhere = persist(rows, "full.txt", join(root, "elsewhere"));
    const link = join(results, "link.txt");
    mkdirSync(results, { recursive: true });
    symlinkSync(elsewhere, link);
    const other = rows.replace("padding 1\n", "padding X\n");
    const cases: Array<Record<string, unknown>> = [
      { persistedOutputPath: join(results, "missing.txt") },
      { persistedOutputPath: elsewhere },
      { persistedOutputPath: link },
      { persistedOutputPath: "tool-results/full.txt" },
      { persistedOutputPath: results },
      { persistedOutputPath: persist(other, "other.txt") },
      { persistedOutputSize: Buffer.byteLength(rows, "utf8") + 5 },
      { persistedOutputSize: "150893" },
      { persistedOutputPath: 42 },
      { stdout: "" }
    ];
    for (const extra of cases) {
      expect(await postToolUseResponse(bash("cat big.txt", rows, extra))).toBe("");
    }
    expect(statRows()).toHaveLength(0);
  });

  it("leaves the output untouched when the persisted file exceeds 10 MB", async () => {
    const huge = "row data value with some padding\n".repeat(330_000);
    expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(10 * 1024 * 1024);
    expect(await postToolUseResponse(bash("cat big.txt", huge))).toBe("");
  });

  it("matches the persisted size in characters as well as bytes", async () => {
    const accented = rows.replace(/padding/g, "remplissage é");
    const payload = bash("cat big.txt", accented, { persistedOutputSize: accented.length });
    const envelope = JSON.parse(await postToolUseResponse(payload));
    expect(await readContentCache(restoreHash(envelope.hookSpecificOutput.updatedToolOutput.stdout))).toBe(accented);
  });

  it("keeps the current behaviour when stdout already holds the whole output", async () => {
    const small = rows.slice(0, 20_000);
    const payload = bash("cat big.txt", small, { persistedOutputPath: join(results, "absent.txt"), persistedOutputSize: small.length });
    const envelope = JSON.parse(await postToolUseResponse(payload));
    const updated = envelope.hookSpecificOutput.updatedToolOutput;
    expect(updated.persistedOutputPath).toBeUndefined();
    expect(await readContentCache(restoreHash(updated.stdout))).toBe(small);
  });

  it("defers accounting once, only for a delivered persisted output", async () => {
    const commits: Array<() => Promise<void>> = [];
    const deferAccounting = (commit: () => Promise<void>) => { commits.push(commit); };
    expect(await processToolOutput(bash("cat big.txt", rows), { deferAccounting })).not.toBeNull();
    expect(await processToolOutput(bash("cat big.txt", rows, { stderr: "x" }), { deferAccounting })).toBeNull();
    expect(commits).toHaveLength(1);
    await commits[0]!();
    await commits[0]!();
    expect(statRows()).toHaveLength(1);
  });
});
