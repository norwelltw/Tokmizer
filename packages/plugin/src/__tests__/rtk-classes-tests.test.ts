import { describe, expect, it } from "vitest";
import { summarizeTestFailures } from "../engine/test-failures";

function vitest(frame: string, extra: string[] = []): string {
  return [
    " FAIL  src/a.test.ts > adds",
    "AssertionError: expected 1 to be 2",
    "",
    ` ❯ ${frame}`,
    "",
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
    "",
    " Test Files  1 failed (1)",
    "      Tests  1 failed | 2 passed (3)",
    ...extra
  ].join("\n");
}

describe("file:// URLs in vitest frames", () => {
  it("decodes a Windows drive path without the leading slash", () => {
    const out = summarizeTestFailures(vitest("file:///C:/Users/John%20Doe/proj/src/a.test.ts:3:10"))!;
    expect(out).toContain("C:/Users/John Doe/proj/src/a.test.ts:3");
    expect(out).not.toContain("%20");
    expect(out).not.toContain("/C:/");
  });

  it("keeps POSIX paths correct", () => {
    const out = summarizeTestFailures(vitest("file:///home/jo%20e/proj/src/a.test.ts:3:10"))!;
    expect(out).toContain("/home/jo e/proj/src/a.test.ts:3");
  });
});

describe("pytest summary", () => {
  it("ignores a summary-shaped line printed by a test", () => {
    const raw = [
      "============================= test session starts ==============================",
      "collected 2 items",
      "",
      "=================================== FAILURES ===================================",
      "___________________________________ test_a ____________________________________",
      "",
      "    def test_a():",
      "        print('1 passed in 0.01s')",
      ">       assert False",
      "E       assert False",
      "",
      "t.py:3: AssertionError",
      "----------------------------- Captured stdout call -----------------------------",
      "1 passed in 0.01s",
      "=========================== short test summary info ============================",
      "FAILED t.py::test_a - assert False",
      "========================= 1 failed, 1 passed in 0.05s =========================="
    ].join("\n");
    const out = summarizeTestFailures(raw)!;
    expect(out).toContain("1 failed, 1 passed");
    expect(out.split("\n").filter((l) => l.trim() === "1 passed")).toHaveLength(0);
  });

  it("still accepts the quiet-mode final line", () => {
    const raw = [
      "FAILED t.py::test_a - assert False",
      "1 failed, 1 passed in 0.05s"
    ].join("\n");
    expect(summarizeTestFailures(raw)!).toContain("1 failed, 1 passed");
  });
});

describe("vitest coverage threshold", () => {
  it("keeps the coverage ERROR line when a test also fails", () => {
    const line = "ERROR: Coverage for lines (50%) does not meet global threshold (80%)";
    const out = summarizeTestFailures(vitest("/repo/src/a.test.ts:3:10", ["", line]))!;
    expect(out).toContain(line);
  });
});
