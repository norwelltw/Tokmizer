import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFilters, __resetCache } from "../engine/loader";
import { selectFilter, __resetMatcherCache } from "../engine/matcher";
import { applyFilter } from "../engine/pipeline";
import { defaultRulesFilters } from "../default-rules-build";
import { foldPassing } from "../engine/transforms/fold-passing";
import "../engine/transforms/smart-grep";

let origDev: string | undefined;

beforeEach(() => {
  origDev = process.env.TOKMIZER_DEV;
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
  __resetMatcherCache();
});

afterEach(() => {
  if (origDev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = origDev;
  __resetCache();
  __resetMatcherCache();
});

const GIT_STATUS = [
  "On branch master",
  "Your branch is up to date with 'origin/master'.",
  "",
  "Changes not staged for commit:",
  '  (use "git add <file>..." to update what will be committed)',
  '  (use "git restore <file>..." to discard changes in working directory)',
  "\tmodified:   app/src/x.ts",
  "",
  "Untracked files:",
  '  (use "git add <file>..." to include in what will be committed)',
  "\tdocs/new.md",
  "",
  'no changes added to commit (use "git add" and/or "git commit -a")'
].join("\n");

describe("git filters (declarative upgrade)", () => {
  it("routes git status to a dedicated filter that outranks the generic git one", async () => {
    const filters = await loadFilters();
    const chosen = selectFilter("git status", filters.values(), null);
    expect(chosen).not.toBeNull();
    expect(chosen!.slug).toBe("git-status");
    expect(chosen!.priority).toBeGreaterThan(filters.get("git")!.priority);
  });

  it("strips the (use \"git …\") hint lines but keeps the state", async () => {
    const filters = await loadFilters();
    const chosen = selectFilter("git status", filters.values(), null)!;
    const out = applyFilter(GIT_STATUS, chosen);
    expect(out).toContain("modified:   app/src/x.ts");
    expect(out).toContain("docs/new.md");
    expect(out).toContain("On branch master");
    expect(out).not.toContain('(use "git add');
    expect(out).not.toContain('(use "git restore');
  });

  it("routes git diff to a dedicated filter with a line cap", async () => {
    const filters = await loadFilters();
    const chosen = selectFilter("git diff --stat", filters.values(), null);
    expect(chosen).not.toBeNull();
    expect(chosen!.slug).toBe("git-diff");
    expect(chosen!.max_lines).toBeGreaterThan(80);
  });
});

describe("grep-tool uses smart-grep grouping", () => {
  it("groups native Grep output by file", async () => {
    const filters = await loadFilters();
    const chosen = selectFilter("grep-tool: grep Error", filters.values(), null)!;
    expect(chosen.transform).toBe("smart-grep");
    const sample = [
      "src/a.ts:10:throw new Error('x')",
      "src/a.ts:22:catch (Error)",
      "src/b.ts:5:Error handling"
    ].join("\n");
    const out = applyFilter(sample, chosen);
    expect(out.split("\n")[0]).toBe("3m 2f in src/:");
    expect(out).toContain("a.ts (2):");
    expect(out).toContain("b.ts (1):");
  });
});

describe("built-in rules cover the generic bash-tool squeeze", () => {
  it("includes bash-tool", async () => {
    expect((await defaultRulesFilters()).map((f) => f.slug)).toContain("bash-tool");
  });
});

describe("fold-passing marker", () => {
  it("announces folded passing checks in english", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `✓ test ${i} passes`);
    const out = foldPassing(lines, 5);
    expect(out.join("\n")).toMatch(/… 8 passing checks folded …/);
    expect(out.join("\n")).not.toContain("repliées");
  });
});
