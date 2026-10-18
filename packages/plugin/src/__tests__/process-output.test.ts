import { afterEach, describe, expect, it } from "vitest";
import { processOutput, setFilterResolver } from "../engine";
import type { LoadedFilter } from "../engine/loader";

const stub: LoadedFilter = {
  slug: "stub",
  match_command: ".*",
  priority: 50,
  strip_ansi: false,
  strip_lines_matching: ["^line3$"],
  matchRegex: /.*/
};

afterEach(() => {
  setFilterResolver(null);
});

describe("processOutput exit-code bypass", () => {
  it("on a failing run preserves context that matches a strip pattern", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("tsc -p .", "line1\nline2\nline3", null, { exitCode: 1 });
    expect(r.filterId).toBe("stub");
    expect(r.debugBypass).toBe(true);
    expect(r.output).toBe("line1\nline2\nline3");
  });

  it("on a failing run keeps failure lines even when a strip pattern matches them", async () => {
    setFilterResolver(async () => ({ ...stub, strip_lines_matching: ["^\\s*(?:✓|FAIL|Error)"] }));
    const out = "✓ ok one\n✓ ok two\nFAIL src/a.test.ts\nError: boom\n    at fn (src/a.ts:3:1)";
    const r = await processOutput("npm test", out, null, { exitCode: 1 });
    expect(r.output).toBe(out);
  });

  it("on a failing run never truncates and skips the transform", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `    at frame${i} (src/x.ts:${i}:1)`);
    setFilterResolver(async () => ({ ...stub, max_lines: 5, transform: "smart-read" }));
    const r = await processOutput("npm test", lines.join("\n"), null, { exitCode: 2 });
    expect(r.output).toBe(lines.join("\n"));
  });

  it("treats grep exit 1 (no match) as success and applies the filter", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("grep -rn foo src", "line1\nline2\nline3", null, { exitCode: 1 });
    expect(r.debugBypass).toBe(false);
    expect(r.filterId).toBe("stub");
    expect(r.filteredBytes).toBeLessThan(r.rawBytes);
  });

  it("treats rg exit 1 (no match) as success and applies the filter", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("rg foo", "line1\nline2\nline3", null, { exitCode: 1 });
    expect(r.debugBypass).toBe(false);
    expect(r.filterId).toBe("stub");
  });

  it("still bypasses grep on exit 2 (real error)", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("grep -rn foo missing", "grep: missing: No such file or directory", null, { exitCode: 2 });
    expect(r.debugBypass).toBe(true);
    expect(r.output).toBe("grep: missing: No such file or directory");
  });

  it("does not treat exit 1 as benign for a command merely containing grep", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("mygrep foo", "line1", null, { exitCode: 1 });
    expect(r.debugBypass).toBe(true);
  });

  it("compresses on exit 0", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("tsc -p .", "line1\nline2\nline3", null, { exitCode: 0 });
    expect(r.filterId).toBe("stub");
    expect(r.debugBypass).toBe(false);
    expect(r.filteredBytes).toBeLessThan(r.rawBytes);
  });

  it("compresses when exitCode is omitted (success-by-default)", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("tsc -p .", "line1\nline2\nline3", null);
    expect(r.filterId).toBe("stub");
  });

  it("trusts a successful exit code even when the output mentions errors", async () => {
    setFilterResolver(async () => stub);
    const out = "line1\nline2 ERROR in a commit message\nline3\nfix: TypeError: was thrown";
    const r = await processOutput("git log", out, null, { exitCode: 0 });
    expect(r.debugBypass).toBe(false);
    expect(r.filterId).toBe("stub");
    expect(r.filteredBytes).toBeLessThan(r.rawBytes);
  });

  it("preserves suspected failure context when the exit code is unknown", async () => {
    setFilterResolver(async () => stub);
    const out = "ERROR: something broke\n" + Array.from({ length: 40 }, () => "line3").join("\n");
    const r = await processOutput("bash-tool: cat app.log", out, null);
    expect(r.debugBypass).toBe(true);
    expect(r.filterId).toBe("stub");
    expect(r.output).toBe(out);
    expect(r.output).toContain("ERROR: something broke");
  });

  it("keeps failure lines even when the matched filter would strip them", async () => {
    const aggressive: LoadedFilter = {
      slug: "agg",
      match_command: ".*",
      priority: 50,
      strip_ansi: false,
      strip_lines_matching: ["ERROR", "^line3$"],
      matchRegex: /.*/
    };
    setFilterResolver(async () => aggressive);
    const out = "ERROR: boom\n" + Array.from({ length: 40 }, () => "line3").join("\n");
    const r = await processOutput("bash-tool: cat app.log", out, null);
    expect(r.debugBypass).toBe(true);
    expect(r.filterId).toBe("agg");
    expect(r.output).toContain("ERROR: boom");
    expect(r.output).toBe(out);
  });

  it("still bypasses failure-looking output when no filter matches", async () => {
    setFilterResolver(async () => null);
    const out = "Traceback (most recent call last):\n  File \"a.py\", line 1\nline3";
    const r = await processOutput("some-tool", out, null);
    expect(r.debugBypass).toBe(true);
    expect(r.filterId).toBeNull();
  });
});

describe("processOutput routing candidates", () => {
  it("routes bash-tool synthetic to the dedicated filter of the inner command", async () => {
    const tried: string[] = [];
    setFilterResolver(async (cmd) => {
      tried.push(cmd);
      return /^grep(\s|$)/.test(cmd) ? { ...stub, slug: "grep" } : null;
    });
    const r = await processOutput("bash-tool: grep -rn foo src/", "line1\nline2\nline3", null, {});
    expect(r.filterId).toBe("grep");
    expect(tried[0]).toBe("grep -rn foo src/");
  });

  it("routes a piped bash-tool command via its producing segment", async () => {
    setFilterResolver(async (cmd) =>
      /^grep(\s|$)/.test(cmd) ? { ...stub, slug: "grep" } : null
    );
    const r = await processOutput("bash-tool: git log | grep foo", "line1\nline2\nline3", null, {});
    expect(r.filterId).toBe("grep");
  });

  it("falls back to the synthetic (generic bash-tool) when no dedicated filter matches", async () => {
    setFilterResolver(async (cmd) =>
      cmd.startsWith("bash-tool:") ? { ...stub, slug: "bash-tool" } : null
    );
    const r = await processOutput("bash-tool: weirdcmd --x", "line1\nline2\nline3", null, {});
    expect(r.filterId).toBe("bash-tool");
  });

  it("normalizes env-assignment and abs-path heads on the exec path", async () => {
    setFilterResolver(async (cmd) =>
      /^git(\s|$)/.test(cmd) ? { ...stub, slug: "git" } : null
    );
    const r = await processOutput("NODE_ENV=x /usr/bin/git log", "line1\nline2\nline3", null, { exitCode: 0 });
    expect(r.filterId).toBe("git");
  });

  it("falls back to the bash-tool catch-all for a big unmatched shell output", async () => {
    setFilterResolver(async (cmd) =>
      cmd.startsWith("bash-tool:") ? { ...stub, slug: "bash-tool" } : null
    );
    const big = "line1\n" + "line3\n".repeat(400);
    const r = await processOutput("ssh prod tail -n 500 app.log", big, null, { exitCode: 0 });
    expect(r.filterId).toBe("bash-tool");
    expect(r.filteredBytes).toBeLessThan(r.rawBytes);
  });

  it("does not fall back below the size gate", async () => {
    setFilterResolver(async (cmd) =>
      cmd.startsWith("bash-tool:") ? { ...stub, slug: "bash-tool" } : null
    );
    const r = await processOutput("ssh prod tail app.log", "line1\nline2\nline3", null, { exitCode: 0 });
    expect(r.filterId).toBeNull();
    expect(r.output).toBe("line1\nline2\nline3");
  });

  it("never falls back to the catch-all for read/grep/glob tool output", async () => {
    setFilterResolver(async (cmd) =>
      cmd.startsWith("bash-tool:") ? { ...stub, slug: "bash-tool" } : null
    );
    const big = "line1\n" + "line3\n".repeat(400);
    const r = await processOutput("read-tool: /a/b.ts", big, null, {});
    expect(r.filterId).toBeNull();
    expect(r.output).toBe(big);
  });

  it("stays passthrough when the catch-all is not in the delivered catalog", async () => {
    setFilterResolver(async () => null);
    const big = "line1\n" + "line3\n".repeat(400);
    const r = await processOutput("ssh prod tail app.log", big, null, { exitCode: 0 });
    expect(r.filterId).toBeNull();
    expect(r.output).toBe(big);
  });
});

describe("processOutput exit-1 findings commands", () => {
  it("treats find exit 1 (partial errors) as compressible", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("find / -name x", "line1\nline2\nline3", null, { exitCode: 1 });
    expect(r.debugBypass).toBe(false);
    expect(r.filterId).toBe("stub");
  });

  it("treats eslint exit 1 (findings) as compressible", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("eslint src/", "line1\nline2\nline3", null, { exitCode: 1 });
    expect(r.debugBypass).toBe(false);
  });

  it("treats git diff exit 1 (differences) as compressible", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("git diff --exit-code", "line1\nline2\nline3", null, { exitCode: 1 });
    expect(r.debugBypass).toBe(false);
  });

  it("tolerates exit 1 for a piped grep (last segment)", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("git log | grep foo", "line1\nline2\nline3", null, { exitCode: 1 });
    expect(r.debugBypass).toBe(false);
  });

  it("still bypasses tsc exit 1 (type errors stay intact)", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("tsc -p .", "line1\nline2\nline3", null, { exitCode: 1 });
    expect(r.debugBypass).toBe(true);
  });
});

describe("processOutput failure heuristic scope", () => {
  it("exitCode 0 disables the heuristic even for error-looking content", async () => {
    setFilterResolver(async () => stub);
    const r = await processOutput("read-tool /a/handler.ts", "ERROR handling code\nline2\nline3", null, { exitCode: 0 });
    expect(r.debugBypass).toBe(false);
    expect(r.filterId).toBe("stub");
  });
});
