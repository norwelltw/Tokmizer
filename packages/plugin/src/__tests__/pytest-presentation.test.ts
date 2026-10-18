import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processOutput, setFilterResolver } from "../engine";
import { __resetCache } from "../engine/loader";

const input = [
  "============================= test session starts ==============================",
  "platform linux -- Python 3.12.0, pytest-8.0.0",
  "collected 2 items",
  "tests/test_payment.py::test_valid PASSED [ 50%]",
  "tests/test_payment.py::test_invalid FAILED [100%]",
  "=================================== FAILURES ===================================",
  "_________________________________ test_invalid _________________________________",
  "    def test_invalid():",
  ">       assert charge(0) == 42",
  "E       AssertionError: expected invoice 42, got 0",
  "tests/test_payment.py:18: AssertionError",
  "=========================== short test summary info ============================",
  "FAILED tests/test_payment.py::test_invalid - AssertionError: expected invoice 42, got 0",
  "========================= 1 failed, 1 passed in 0.03s ==========================",
  ""
].join("\n");

beforeEach(() => {
  vi.stubEnv("TOKMIZER_DEV", "1");
  __resetCache();
  setFilterResolver(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetCache();
  setFilterResolver(null);
});

it.each(["normal", "compact", "minimal"] as const)("keeps every pytest diagnostic of a failing run at %s while dropping passing tests", async (verbosity) => {
  const result = await processOutput("pytest -v", input, null, { verbosity, exitCode: 1 });
  expect(result.output.split("\n")).toEqual([
    "tests/test_payment.py",
    "× test_invalid tests/test_payment.py:18",
    "  assert charge(0) == 42",
    "  E AssertionError: expected invoice 42, got 0",
    "1 failed, 1 passed",
    ""
  ]);
  expect(result.droppedTail).toBe(input);
  expect(result.filteredBytes).toBeLessThan(result.rawBytes * 0.5);
  expect(result.debugBypass).toBe(true);
});

const deep = [
  "============================= test session starts ==============================",
  "collected 1 item",
  "=================================== FAILURES ===================================",
  "_________________________________ test_divide _________________________________",
  "",
  "    def test_divide():",
  ">       assert divide(10, 0) == 0",
  "",
  "tests/test_math.py:14: ",
  "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _",
  "",
  "    def divide(a, b):",
  ">       return helper(a) / b",
  "E       ZeroDivisionError: division by zero",
  "",
  "src/math.py:3: ZeroDivisionError",
  "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _",
  "",
  ">   raise ValueError(x)",
  "",
  "/usr/lib/python3.12/site-packages/lib/core.py:9: ValueError",
  "=========================== short test summary info ============================",
  "FAILED tests/test_math.py::test_divide - ZeroDivisionError: division by zero",
  "========================= 1 failed in 0.12s ==========================",
  ""
].join("\n");

it.each(["normal", "compact", "minimal"] as const)("keeps every user assertion line and the exact pytest location at %s", async (verbosity) => {
  const result = await processOutput("pytest tests/", deep, null, { verbosity, exitCode: 1 });
  expect(result.output).toContain("assert divide(10, 0) == 0");
  expect(result.output).toContain("return helper(a) / b");
  expect(result.output).toContain("src/math.py:3");
  expect(result.output).not.toContain("raise ValueError(x)");
  expect(result.output).toContain("E ZeroDivisionError: division by zero");
  expect(result.output).not.toContain("site-packages");
});

it("keeps unrelated failing commands verbatim", async () => {
  expect((await processOutput("node script.js", input, null, { verbosity: "minimal", exitCode: 1 })).output).toBe(input);
});
