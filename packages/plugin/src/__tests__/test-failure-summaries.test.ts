import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { processOutput, selectFilter, setFilterResolver, type LoadedFilter } from "../engine";
import { readFilterDir } from "../engine/loader";

const levels = ["normal", "compact", "minimal"] as const;
const HINT_BYTES = Buffer.byteLength("\n[tkr restore 0123456789abcdef]");
let filters: Map<string, LoadedFilter>;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

function reduction(raw: string, output: string): number {
  return 100 * (1 - (Buffer.byteLength(output) + HINT_BYTES) / Buffer.byteLength(raw));
}

beforeAll(async () => {
  filters = await readFilterDir(fileURLToPath(new URL("../../filters", import.meta.url)));
});

afterEach(() => setFilterResolver(null));

function useCatalog(): void {
  setFilterResolver(async (cmd, allowed) => selectFilter(cmd, filters.values(), allowed, filters));
}

type Case = {
  runner: string;
  cmd: string;
  file: string;
  failing: string[];
  evidence: string[];
  absent: string[];
};

const cases: Case[] = [
  {
    runner: "vitest (single stream)",
    cmd: "npx vitest run",
    file: "test-failures/vitest-combined.txt",
    failing: ["pipeline > case 3 keeps output bounded", "pipeline > case 5 keeps output bounded", "targeted-read > case 3 keeps output bounded", "targeted-read > case 5 keeps output bounded"],
    evidence: ["src/__tests__/pipeline.test.ts", "src/__tests__/targeted-read.test.ts", "AssertionError: expected 4812 to be less than 2406", ":87:38", ":105:38", "Tests 4 failed | 268 passed (272)"],
    absent: ["✓", "Duration", "Start at", "⎯"]
  },
  {
    runner: "vitest (stderr details)",
    cmd: "vitest run",
    file: "test-failures/vitest-stderr.txt",
    failing: ["add > adds 6", "add > adds 11", "user > builds admin", "user > is active", "user > throws"],
    evidence: ["expected 8 to be 7", "expected 13 to be 12", "to deeply equal", '-     "admin",', '+     "user",', "expected false to be true", "TypeError: cannot read properties of undefined (reading 'x')", ":4:74", ":7:50", ":8:54", ":9:30"],
    absent: ["import { add, user }", "⎯"]
  },
  {
    runner: "vitest (stdout listing)",
    cmd: "npx vitest run",
    file: "test-failures/vitest-stdout.txt",
    failing: ["adds 6", "adds 11", "builds admin", "is active", "throws"],
    evidence: ["src/math.test.ts", "Tests 9 failed | 26 passed (35)"],
    absent: ["Duration", "RUN  v"]
  },
  {
    runner: "jest",
    cmd: "npx jest --ci",
    file: "test-failures/jest.txt",
    failing: ["string", "cart › sums quantities", "cart › deep shape", "cart › lookup missing"],
    evidence: ['Expected: "hello there"', 'Received: "hello world"', "Expected: 11", "Received: 6", "TypeError: Cannot read properties of undefined (reading 'value')", "src/cart.js:2:41", ":4:87", "Tests: 4 failed, 18 passed, 22 total"],
    absent: ["Ran all test suites", "Time:"]
  },
  {
    runner: "jest --verbose",
    cmd: "jest --verbose",
    file: "test-failures/jest-verbose.txt",
    failing: ["cart › sums quantities", "cart › deep shape", "cart › lookup missing", "string"],
    evidence: ["Expected: 11", "Received: 6", "Tests: 4 failed, 18 passed, 22 total"],
    absent: ["✓ passes", "passes 9"]
  },
  {
    runner: "mocha",
    cmd: "npx mocha test",
    file: "test-failures/mocha.txt",
    failing: ["cart (mocha) › sums quantities", "cart (mocha) › deep", "cart (mocha) › lookup › missing key"],
    evidence: ["Expected values to be strictly equal", "6 !== 11", "Expected values to be strictly deep-equal", "test/cart.spec.js:5:40", "src/cart.js:2:41", "3 failing"],
    absent: ["✔ ok 0", "node:internal"]
  },
  {
    runner: "pytest -v",
    cmd: "pytest -v",
    file: "test-failures/pytest-verbose.txt",
    failing: ["test_add", "TestParse::test_bad_json", "TestParse::test_dict", "test_param[2]"],
    evidence: ["tests/test_calc.py", "E assert (1 + 2) == 4", "JSONDecodeError: Expecting property name", "tests/helpers.py:3", "{'b': [1, 2]} != {'b': [1, 3]}", "E assert 2 == 1", ":9", ":20", "4 failed, 16 passed"],
    absent: ["PASSED", "rootdir:", "/Library/Developer", "self = <"]
  },
  {
    runner: "pytest -q",
    cmd: "python -m pytest -q",
    file: "test-failures/pytest-quiet.txt",
    failing: ["test_add", "TestParse::test_bad_json", "TestParse::test_dict", "test_param[2]"],
    evidence: ["E assert (1 + 2) == 4", "JSONDecodeError", "E assert 2 == 1", "4 failed, 16 passed"],
    absent: ["...............FFF.F", "in 0.03s"]
  },
  {
    runner: "cargo test",
    cmd: "cargo test",
    file: "test-failures/cargo.txt",
    failing: ["tests::truthy", "tests::big", "tests::empty"],
    evidence: ["assertion failed: add(0, 0) > 0", "adding 6 and 1", "left: 8", "right: 7", "index out of bounds", "src/lib.rs:12:27", "src/lib.rs:10:24", "src/lib.rs:2:34", "test result: FAILED. 4 passed; 3 failed", "error: test failed, to rerun pass `--lib`"],
    absent: ["... ok", "Compiling", "RUST_BACKTRACE"]
  },
  {
    runner: "go test -v",
    cmd: "go test -v ./...",
    file: "test-failures/go.txt",
    failing: ["TestAdd", "TestTable", "TestTable/negative", "TestFirst"],
    evidence: ["calc_test.go:10: Add(2, 2) = 5, want 4", "calc_test.go:31: Abs(-3) = -3, want 3", "index out of range [0] with length 0", "/home/dev/calc/calc.go:18", "/home/dev/calc/calc_test.go:44", "FAIL\texample.com/calc"],
    absent: ["--- PASS", "=== RUN", "/usr/local/go/src", "TestSub"]
  },
  {
    runner: "playwright",
    cmd: "npx playwright test",
    file: "test-failures/playwright.txt",
    failing: ["tests/login.spec.ts:10:5 › logs in with valid password", "tests/cart.spec.ts:21:7 › cart › shows total"],
    evidence: ["Timed out 5000ms waiting for expect(locator).toBeVisible()", "Expected: visible", "Received: <element(s) not found>", 'Expected: "$42.00"', 'Received: "$40.00"', "tests/login.spec.ts:14:68", "tests/cart.spec.ts:23:56", "2 failed"],
    absent: ["✓", "has title", "node_modules"]
  }
];

describe("failing test runs keep every failure with its assertion", () => {
  for (const c of cases) {
    it.each(levels)(`${c.runner} at %s`, async (verbosity) => {
      useCatalog();
      const raw = fixture(c.file);
      const result = await processOutput(c.cmd, raw, null, { verbosity, exitCode: 1 });
      expect(result.failureSummary).toBe(true);
      expect(result.droppedTail).toBe(raw);
      expect(result.filteredBytes).toBe(Buffer.byteLength(result.output));
      expect(result.filteredBytes).toBeLessThan(result.rawBytes);
      for (const name of c.failing) expect(result.output).toContain(name);
      const kept = verbosity === "minimal" ? c.evidence.filter((e) => !e.startsWith("tests/helpers.py") && !e.startsWith("/home/dev/calc/calc_test.go")) : c.evidence;
      for (const needle of kept) expect(result.output).toContain(needle);
      for (const needle of c.absent) expect(result.output).not.toContain(needle);
      expect(result.output).not.toMatch(/\x1b\[/);
    });
  }

  it.each(cases.map((c) => [c.runner, c] as const))("orders the levels from most to least context for %s", async (_runner, c) => {
    useCatalog();
    const raw = fixture(c.file);
    const sizes = [];
    for (const verbosity of levels) sizes.push((await processOutput(c.cmd, raw, null, { verbosity, exitCode: 1 })).filteredBytes);
    expect(sizes[0]).toBeGreaterThanOrEqual(sizes[1]!);
    expect(sizes[1]).toBeGreaterThanOrEqual(sizes[2]!);
  });

  it.each(["npm test", "npm run test", "pnpm test", "yarn test", "npm run test:unit", "bun run test"])("summarises %s wrapping a runner", async (cmd) => {
    useCatalog();
    const raw = fixture("test-failures/vitest-combined.txt");
    const result = await processOutput(cmd, raw, null, { verbosity: "compact", exitCode: 1 });
    expect(result.failureSummary).toBe(true);
    expect(result.output).toContain("AssertionError: expected 4812 to be less than 2406");
    expect(result.output).toContain("targeted-read > case 5 keeps output bounded :105:38");
  });
});

describe("reduction against the rtk comparison fixtures", () => {
  it.each(["compact", "minimal"] as const)("reduces the four-failure vitest run at %s and keeps the assertion message and its source line", async (verbosity) => {
    useCatalog();
    const raw = fixture("test-failures/vitest-combined.txt");
    const result = await processOutput("npx vitest run", raw, null, { verbosity, exitCode: 1 });
    expect(reduction(raw, result.output)).toBeGreaterThanOrEqual(86.5);
    expect(result.output).toContain("expected 4812 to be less than 2406");
    expect(result.output).toContain("87|     expect(result.filteredBytes).toBeLessThan(result.rawBytes / 2);");
    expect(result.output).toContain("105|     expect(result.filteredBytes).toBeLessThan(result.rawBytes / 2);");
  });

  it.each(["compact", "minimal"] as const)("beats rtk on the 155-failure pytest run at %s while listing every failing test", async (verbosity) => {
    useCatalog();
    const raw = fixture("audit/pytest.txt");
    const ids = [...raw.matchAll(/FAILED\S* tests\/integration\/test_filter_chain\.py::test_([0-9a-f]+)/g)].map((m) => m[1]!);
    expect(ids.length).toBe(155);
    const result = await processOutput("pytest -v", raw, null, { verbosity, exitCode: 1 });
    expect(result.failureSummary).toBe(true);
    expect(reduction(raw, result.output)).toBeGreaterThanOrEqual(98.7);
    for (const id of ids) expect(result.output).toContain(id);
    expect(result.output).toContain("AssertionError: expected output to match snapshot");
    expect(result.output).toContain('E assert "compiled output f9607cf3d1" == "expected 882611fd30"');
    expect(result.output).not.toContain("PASSED");
  });
});

describe("unchanged behaviour outside failing test runs", () => {
  it("leaves passing runs on the existing path", async () => {
    useCatalog();
    const raw = fixture("audit/vitest.txt");
    const result = await processOutput("npx vitest run", raw, null, { verbosity: "compact", exitCode: 0 });
    expect(result.failureSummary).toBeUndefined();
  });

  it("leaves YOLO on its own path", async () => {
    useCatalog();
    const raw = fixture("test-failures/vitest-combined.txt");
    const result = await processOutput("npx vitest run", raw, null, { yolo: true, exitCode: 1 });
    expect(result.failureSummary).toBeUndefined();
  });

  it("does not summarise non-test commands that print test-like text", async () => {
    useCatalog();
    const raw = fixture("test-failures/vitest-combined.txt");
    const result = await processOutput("cat build.log", raw, null, { verbosity: "minimal", exitCode: 1 });
    expect(result.failureSummary).toBeUndefined();
  });

  it("falls back to the full failure output when a reported failure cannot be matched", async () => {
    useCatalog();
    const raw = fixture("test-failures/vitest-combined.txt");
    const start = raw.indexOf(" FAIL  src/__tests__/targeted-read.test.ts > targeted-read > case 5");
    const truncated = raw.slice(0, start) + raw.slice(raw.indexOf(" Test Files"));
    const result = await processOutput("npx vitest run", truncated, null, { verbosity: "minimal", exitCode: 1 });
    expect(result.failureSummary).toBeUndefined();
    expect(result.output).toContain("targeted-read > case 3 keeps output bounded");
    expect(result.output).toContain("Start at");
  });

  it("detects a failing run without an exit code from its content", async () => {
    useCatalog();
    const raw = fixture("test-failures/pytest-verbose.txt");
    const result = await processOutput("bash-tool: pytest -v", raw, null, { verbosity: "compact" });
    expect(result.failureSummary).toBe(true);
    expect(result.output).toContain("TestParse::test_dict");
  });
});
