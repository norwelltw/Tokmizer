import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { smartCtest } from "../engine/transforms/smart-ctest";
import { smartPhpstan } from "../engine/transforms/smart-phpstan";
import { bunFrames } from "../engine/transforms/bun-frames";
import { applyFilter } from "../engine/pipeline";
import { processOutput, setFilterResolver, selectFilter, loadFilters } from "../engine";
import { __resetCache } from "../engine/loader";

let dev: string | undefined;
beforeEach(() => {
  dev = process.env.TOKMIZER_DEV;
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
  setFilterResolver(async (cmd, allowed) => selectFilter(cmd, (await loadFilters()).values(), allowed));
});
afterEach(() => {
  setFilterResolver(null);
  if (dev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = dev;
  __resetCache();
});

describe("smartCtest", () => {
  it("keeps every result and summary line, merges repeats and caps long failure output", () => {
    const noise = Array.from({ length: 30 }, (_, i) => `noise ${i}`);
    const out = smartCtest([
      "Test project /tmp/build",
      " 1/2 Test  #1: unit_a .........................***Failed    0.01 sec",
      ...noise,
      "missing-command",
      "missing-command",
      " 2/2 Test  #2: unit_b .........................***Timeout   1.00 sec",
      "50% tests passed, 2 tests failed out of 2",
      "The following tests FAILED:",
      "\t  1 - unit_a (Failed)",
      "\t  2 - unit_b (Timeout)",
      "Errors while running CTest"
    ]);
    expect(out).toContain(" 1/2 Test  #1: unit_a .........................***Failed    0.01 sec");
    expect(out).toContain(" 2/2 Test  #2: unit_b .........................***Timeout   1.00 sec");
    expect(out).toContain("missing-command ×2");
    expect(out).toContain("noise 0");
    expect(out).toContain("noise 29");
    expect(out.some((l) => /more lines omitted/.test(l))).toBe(true);
    expect(out).toContain("The following tests FAILED:");
    expect(out).toContain("\t  1 - unit_a (Failed)");
    expect(out).toContain("50% tests passed, 2 tests failed out of 2");
    expect(out).toContain("Errors while running CTest");
  });

  it("leaves other output alone", () => {
    expect(smartCtest(["hello", "world"])).toEqual(["hello", "world"]);
  });
});

describe("smartPhpstan", () => {
  const report = {
    totals: { errors: 2, file_errors: 2 },
    files: {
      "/srv/app/src/A.php": { errors: 1, messages: [{ message: "Undefined variable $x.", line: 4, ignorable: true, identifier: "variable.undefined", tip: null }] },
      "/srv/app/src/Sub/B.php": { errors: 1, messages: [{ message: "Method B::f() has no return type.", line: 9, ignorable: true, identifier: "missingType.return", tip: "Add a return type." }] }
    },
    errors: []
  };
  it("turns a JSON report into one line per error and keeps every message, line and tip", () => {
    const out = smartPhpstan(JSON.stringify(report, null, 2).split("\n"));
    expect(out).toEqual([
      "phpstan: 2 errors in 2 files under /srv/app/src/",
      "A.php (1)",
      "  :4 Undefined variable $x.",
      "Sub/B.php (1)",
      "  :9 Method B::f() has no return type. — Add a return type."
    ]);
  });
  it("leaves text reports and broken JSON alone", () => {
    expect(smartPhpstan(["  Line   A.php", "  4      Undefined variable $x."])).toEqual(["  Line   A.php", "  4      Undefined variable $x."]);
    expect(smartPhpstan(["{", "\"files\":"])).toEqual(["{", "\"files\":"]);
  });
});

describe("bunFrames", () => {
  it("keeps the failing code line and drops the context lines and the caret", () => {
    expect(bunFrames([
      "1 | import { test } from \"bun:test\";",
      "2 | test(\"a\", () => { expect(1).toBe(2); });",
      "                         ^",
      "error: expect(received).toBe(expected)"
    ])).toEqual(["2 | test(\"a\", () => { expect(1).toBe(2); });", "error: expect(received).toBe(expected)"]);
  });
  it("leaves output without a caret alone", () => {
    expect(bunFrames(["1 | a", "2 | b"])).toEqual(["1 | a", "2 | b"]);
  });
});

describe("filter options", () => {
  const base = { slug: "t", match_command: "^t", priority: 50, strip_ansi: false, keep_failures: true, strip_on_failure: false, fold_passing: false, mask_abs_paths: false, preserve_exact: false, scale_with_level: true, transform_on_failure: false };
  it("drops drop_lines_matching lines even when they look like failures", () => {
    const out = applyFilter("[ERROR] -> [Help 1]\n[ERROR] real failure\n", { ...base, strip_lines_matching: ["^\\[ERROR\\] ->"], drop_lines_matching: ["^\\[ERROR\\] -> \\[Help 1\\]$"] });
    expect(out).toBe("[ERROR] real failure\n");
  });
  it("reads Windows line endings", () => {
    const out = applyFilter("[INFO] noise\r\nkeep\r\n", { ...base, strip_lines_matching: ["^\\[INFO\\] noise$"], drop_lines_matching: [] });
    expect(out).toBe("keep\n");
  });
});

describe("failure output", () => {
  it("compacts a failing mvnd test run without losing the failures", async () => {
    const raw = [
      "[INFO] Running com.example.CalcTest",
      "[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.02 s <<< FAILURE! -- in com.example.CalcTest",
      "[ERROR] com.example.CalcTest.failOne -- Time elapsed: 0.007 s <<< FAILURE!",
      "org.opentest4j.AssertionFailedError: expected: <5> but was: <4>",
      "\tat org.junit.jupiter.api.AssertEquals.failNotEqual(AssertEquals.java:197)",
      "\tat com.example.CalcTest.failOne(CalcTest.java:12)",
      "\tat java.base/java.lang.reflect.Method.invoke(Method.java:580)",
      "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.009 s -- in com.example.PassTest",
      "[ERROR] -> [Help 1]",
      "[ERROR] ",
      ""
    ].join("\r\n");
    const r = await processOutput("mvnd test", raw, null, { exitCode: 1 });
    expect(r.output).toContain("org.opentest4j.AssertionFailedError: expected: <5> but was: <4>");
    expect(r.output).toContain("at com.example.CalcTest.failOne(CalcTest.java:12)");
    expect(r.output).not.toContain("org.junit.jupiter");
    expect(r.output).not.toContain("java.base/");
    expect(r.output).not.toContain("PassTest");
    expect(r.output).toContain("[ERROR] -> [Help 1]");
  });

  it("caps long output of a failing ctest run and keeps the summary", async () => {
    const raw = ["Test project /tmp/b", " 1/1 Test  #1: a ..........***Failed    0.01 sec", ...Array.from({ length: 30 }, (_, i) => `trace ${i}`), "0% tests passed, 1 tests failed out of 1", "The following tests FAILED:", "\t  1 - a (Failed)", "Errors while running CTest", ""].join("\n");
    const r = await processOutput("ctest --output-on-failure", raw, null, { exitCode: 8 });
    expect(r.output).toContain(" 1/1 Test  #1: a ..........***Failed    0.01 sec");
    expect(r.output).toContain("The following tests FAILED:");
    expect(r.output).toMatch(/more lines omitted/);
  });
});
