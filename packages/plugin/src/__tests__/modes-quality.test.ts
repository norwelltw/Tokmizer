import { afterEach, describe, expect, it } from "vitest";
import { applyFilterWithTail, processOutput, setFilterResolver } from "../engine";
import { FilterDef } from "../engine/schema";

afterEach(() => setFilterResolver(null));

const levels = ["normal", "compact", "minimal"] as const;

describe("structured mode separation", () => {
  const input = '{\n        "repository": "demo/project",\n        "count": 9007199254740993,\n        "state": "OPEN"\n}\n';

  it("reduces structured whitespace in successive standard levels without changing values", async () => {
    const def = FilterDef.parse({ slug: "gh", match_command: ".*" });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const results = await Promise.all(levels.map((verbosity) => processOutput("gh api repos/demo/project", input, null, { verbosity, exitCode: 0 })));
    expect(results[0].output).toBe(input);
    for (const result of results) {
      expect(JSON.parse(result.output)).toEqual(JSON.parse(input));
      expect(result.output).toContain("9007199254740993");
      expect(result.filteredBytes).toBe(Buffer.byteLength(result.output));
    }
    expect(results[1].filteredBytes).toBeLessThan(results[0].filteredBytes);
    expect(results[2].filteredBytes).toBeLessThan(results[1].filteredBytes);
  });

  it.each(levels)("leaves exact output and known failures unchanged at %s", async (verbosity) => {
    for (const preserve_exact of [false, true]) {
      const def = FilterDef.parse({ slug: "gh", match_command: ".*", preserve_exact });
      setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
      const result = await processOutput("gh api repos/demo/project", input, null, { verbosity, exitCode: preserve_exact ? 0 : 1 });
      expect(result.output).toBe(input);
    }
  });

  it("uses the complete compact value in YOLO when it fits without an excerpt", async () => {
    const def = FilterDef.parse({ slug: "gh", match_command: ".*" });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const result = await processOutput("gh api repos/demo/project", input, null, { yolo: true, exitCode: 0 });
    const maximum = await processOutput("gh api repos/demo/project", input, null, { verbosity: "minimal", exitCode: 0 });
    expect(result.output).toBe(maximum.output);
    expect(result.output).toContain("9007199254740993");
    expect(JSON.parse(result.output)).toEqual(JSON.parse(input));
    expect(result.droppedTail).toBeNull();
  });

  it.each([
    { preserve_exact: true, exitCode: 0 },
    { preserve_exact: false, exitCode: 1 }
  ])("does not reformat a short protected JSON in YOLO: %j", async ({ preserve_exact, exitCode }) => {
    const def = FilterDef.parse({ slug: "gh", match_command: ".*", preserve_exact });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const result = await processOutput("gh api repos/demo/project", input, null, { yolo: true, exitCode });
    expect(result.output).toBe(input);
  });

  it("leaves capped JSON and its restoration fragment unchanged", async () => {
    const def = FilterDef.parse({ slug: "gh", match_command: ".*", max_lines: 30 });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const output = JSON.stringify(Array.from({ length: 100 }, (_, i) => `record-${i}`), null, 4);
    const before = applyFilterWithTail(output, def, { verbosity: "minimal" });
    const result = await processOutput("gh api repos/demo/project/issues", output, null, { verbosity: "minimal", exitCode: 0 });
    expect(result.output).toBe(before.text);
    expect(result.droppedTail).toBe(before.droppedTail);
    expect(result.droppedTail).toContain("record-50");
  });
});

describe("mode fidelity", () => {
  it("keeps the diagnostic excerpt visible in YOLO when verbose noise surrounds a failed command", async () => {
    const def = FilterDef.parse({ slug: "build", match_command: ".*" });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const input = [...Array.from({ length: 60 }, (_, i) => `INFO setup ${i}`), "BEGIN DIAGNOSTIC", "ERROR: invoice total mismatch", "Expected 42; received 0", "src/payment.ts:18:9", "END DIAGNOSTIC", ...Array.from({ length: 60 }, (_, i) => `INFO cleanup ${i}`)].join("\n");
    const result = await processOutput("build", input, null, { exitCode: 2, yolo: true });
    expect(result.output).toContain("BEGIN DIAGNOSTIC");
    expect(result.output).toContain("ERROR: invoice total mismatch");
    expect(result.output).toContain("END DIAGNOSTIC");
    expect(result.filteredBytes).toBeLessThanOrEqual(256);
    expect(result.droppedTail).toBeNull();
  });

  it.each(levels)("does not treat Git history content as a command failure in %s", async (verbosity) => {
    const def = FilterDef.parse({ slug: "git-log", match_command: ".*", transform: "smart-log", strip_lines_matching: ["^\\s*$"] });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const input = "* commit abc1234\n| Author: Developer\n|\n|     Fix 19 errors in tests\n|     handle FAIL and ERROR values\n|     additional implementation details\n|     more implementation details\n";
    const unknown = await processOutput("git log --graph", input, null, { verbosity });
    const successful = await processOutput("git log --graph", input, null, { verbosity, exitCode: 0 });
    expect(unknown.output).toBe(successful.output);
    expect(unknown.debugBypass).toBe(false);
    expect(unknown.filteredBytes).toBeLessThan(unknown.rawBytes);
    expect(unknown.output).toContain("abc1234");
    expect(unknown.output).toContain("Fix 19 errors in tests");
  });

  it.each([
    ["git log", "fatal: missing repository\n", undefined],
    ["git log", "error: cannot read object\n", undefined],
    ["git log", "commit abc1234\n    ERROR in the subject\n", 128],
    ["build; git log", "ERROR: build failed\ncommit abc1234\n    message\n", undefined]
  ] as const)("preserves real or ambiguous Git failures: %s", async (command, input, exitCode) => {
    const def = FilterDef.parse({ slug: "git-log", match_command: ".*", strip_lines_matching: [".*"], on_empty: "git log: no commits" });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const result = await processOutput(command, input, null, { verbosity: "minimal", exitCode });
    expect(result.output).toBe(input);
    expect(result.debugBypass).toBe(true);
  });

  it.each(levels)("keeps the complete middle failure without an exit code in %s", async (verbosity) => {
    const def = FilterDef.parse({ slug: "pytest", match_command: ".*", max_lines: 40, truncate_lines_at: 80, strip_lines_matching: [" PASSED", "DEBUG"] });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const context = [
      "FAIL tests/test_payment.py::test_charge",
      "    def test_charge():",
      ">       assert result == 'PASSED DEBUG'",
      "E       assert 'PASSED' == 'DEBUG'",
      `E       expected ${"invoice ".repeat(40)}42, received 0`,
      "tests/test_payment.py:18: AssertionError"
    ];
    const input = [...Array.from({ length: 90 }, (_, i) => `setup ${i}`), ...context, ...Array.from({ length: 90 }, (_, i) => `cleanup ${i}`), "1 failed"].join("\n");
    const result = await processOutput("pytest -v", input, null, { verbosity });
    for (const line of context) expect(result.output).toContain(line);
    expect(result.output).toContain("1 failed");
    expect(result.debugBypass).toBe(true);
  });

  it.each(levels)("keeps assertion text containing strip keywords on a known failure in %s", async (verbosity) => {
    const def = FilterDef.parse({ slug: "pytest", match_command: ".*", strip_lines_matching: [" PASSED", "DEBUG"] });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const input = "FAIL test_charge\n>       assert value == 'PASSED DEBUG'\nE       assert 'PASSED' == 'DEBUG'\ntests/payment.py:18: AssertionError\n";
    const result = await processOutput("pytest -v", input, null, { verbosity, exitCode: 1 });
    expect(result.output).toBe(input);
  });

  it.each([undefined, 1])("preserves arbitrary diagnostic values and paths with exit code %s", async (exitCode) => {
    const def = FilterDef.parse({ slug: "pytest", match_command: ".*", strip_ansi: true, strip_lines_matching: [" PASSED", "DEBUG"], mask_abs_paths: true, fold_passing: true, max_lines: 2 });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const input = '\u001b[31mFAIL test_invoice\u001b[0m\n{"status": " PASSED", "level": "DEBUG"}\nExpected file /work/project/invoice.json\n' + "✓ literal assertion data\n".repeat(8);
    const result = await processOutput("pytest -v", input, null, { verbosity: "minimal", exitCode });
    expect(result.output).toBe(input.replace(/\u001b\[\d+m/g, ""));
    expect(result.filteredBytes).toBeLessThan(result.rawBytes);
  });
});

describe("maximum test summary", () => {
  const input = [
    "Vite warning: deprecated API",
    " RUN  v1.6.1 /work/project",
    "console output: keep this detail",
    " Test Files  48 passed (48)",
    "      Tests  296 passed (296)",
    "   Start at  12:34:56",
    "   Duration  953ms (transform 128ms, setup 22ms, collect 80ms, tests 125ms)"
  ].join("\n");

  it("removes only recognized successful runner metadata in max", async () => {
    const def = FilterDef.parse({ slug: "vitest", match_command: ".*" });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const results = await Promise.all(levels.map((verbosity) => processOutput("vitest run", input, null, { verbosity, exitCode: 0 })));
    expect(results[0].output).toBe(input);
    expect(results[1].output).toBe(input);
    expect(results[2].output).toContain("48 passed (48)");
    expect(results[2].output).toContain("296 passed (296)");
    expect(results[2].output).toContain("Duration  953ms");
    expect(results[2].output).toContain("Vite warning: deprecated API");
    expect(results[2].output).toContain("console output: keep this detail");
    expect(results[2].output).not.toContain("Start at");
    expect(results[2].output).not.toContain("transform 128ms");
    expect(results[2].output).not.toContain(" RUN ");
    expect(results[2].filteredBytes).toBeLessThan(results[1].filteredBytes);
  });

  it.each([
    ["vitest", input.replace("296 passed (296)", "1 failed | 295 passed (296)"), false, 1],
    ["vitest", input.replace("296 passed (296)", "295 passed (296)"), false, 0],
    ["cat", input, false, 0],
    ["vitest", input, true, 0],
    ["vitest", `${input}\nextra user output`, false, 0]
  ] as const)("preserves unmatched or protected summaries: %s", async (slug, output, preserve_exact, exitCode) => {
    const def = FilterDef.parse({ slug, match_command: ".*", preserve_exact });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const result = await processOutput("demo", output, null, { verbosity: "minimal", exitCode });
    expect(result.output).toBe(output);
  });
});
