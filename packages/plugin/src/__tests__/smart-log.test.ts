import { describe, expect, it } from "vitest";
import { smartLog } from "../engine/transforms/smart-log";
import { FOLD_MARKER_RE } from "../engine/transforms/smart-code";

const commit = (n: number, bodyLines: number): string[] => [
  `commit ${String(n).padStart(40, "a")}`,
  "Author: Dev <dev@example.com>",
  "Date:   Thu Oct 8 18:00:00 2026 +0200",
  `    subject ${n}`,
  ...Array.from({ length: bodyLines }, (_, i) => `    body ${n}.${i}`)
];

describe("smartLog", () => {
  it("keeps every commit header, subject and first body line, and folds the rest", () => {
    const lines = [...commit(1, 6), ...commit(2, 0), ...commit(3, 1)];
    const out = smartLog(lines);
    for (const n of [1, 2, 3]) {
      expect(out).toContain(`commit ${String(n).padStart(40, "a")}`);
      expect(out).toContain(`    subject ${n}`);
    }
    expect(out).toContain("    body 1.0");
    expect(out).not.toContain("    body 1.1");
    expect(out).toContain("    … 5 lines folded …");
    expect(out).toContain("    body 3.0");
    expect(out.filter((l) => FOLD_MARKER_RE.test(l))).toHaveLength(1);
  });

  it("leaves stat and diff lines untouched", () => {
    const lines = [...commit(1, 0), " src/a.ts | 3 ++-", " 1 file changed, 2 insertions(+), 1 deletion(-)"];
    expect(smartLog(lines)).toEqual(lines);
  });

  it("leaves one-line and custom formats alone", () => {
    const lines = ["abc1234 fix one", "def5678 fix two"];
    expect(smartLog(lines)).toEqual(lines);
  });

  it("treats deeper-indented continuation lines as part of the message", () => {
    const lines = [...commit(1, 1), "    - first bullet", "      wrapped continuation", "    - second bullet"];
    const out = smartLog(lines);
    expect(out).toContain("    … 3 lines folded …");
    expect(out).not.toContain("      wrapped continuation");
  });

  it.each([
    ["* ", "| "],
    ["| * ", "| | "],
    ["*   ", "| | "],
    ["* ", "  "]
  ])("folds a graph message without changing its metadata for %j", (headPrefix, bodyPrefix) => {
    const lines = commit(1, 4).map((line, i) => `${i === 0 ? headPrefix : bodyPrefix}${line}`);
    const out = smartLog(lines);

    expect(out).toContain(`${headPrefix}commit ${"1".padStart(40, "a")}`);
    expect(out).toContain(`${bodyPrefix}Author: Dev <dev@example.com>`);
    expect(out).toContain(`${bodyPrefix}Date:   Thu Oct 8 18:00:00 2026 +0200`);
    expect(out).toContain(`${bodyPrefix}    subject 1`);
    expect(out).toContain(`${bodyPrefix}    body 1.0`);
    expect(out).not.toContain(`${bodyPrefix}    body 1.1`);
    expect(out).toContain(`${bodyPrefix}    … 3 lines folded …`);
  });

  it("does not count graph spacing as message content or fold file statistics", () => {
    const lines = [
      "* commit abc1234",
      "| Author: Dev <dev@example.com>",
      "|     ",
      "|     fix payment validation",
      "|     ",
      "|     retain a useful diagnostic",
      "|     extra details",
      "|  src/payment.ts | 2 +-",
      "|  1 file changed, 1 insertion(+), 1 deletion(-)"
    ];
    expect(smartLog(lines)).toEqual([
      "* commit abc1234",
      "| Author: Dev <dev@example.com>",
      "|     ",
      "|     fix payment validation",
      "|     ",
      "|     retain a useful diagnostic",
      "|     … 1 line folded …",
      "|  src/payment.ts | 2 +-",
      "|  1 file changed, 1 insertion(+), 1 deletion(-)"
    ]);
  });

  it.each(["commit deadbee", "* commit deadbee"])("does not mistake message text %j for a header when resetting graph commits", (mention) => {
    const lines = [
      "* commit abc1234",
      "|     first subject",
      "|     first detail",
      `|     ${mention} is mentioned in this body`,
      "|     another detail",
      "* commit def5678",
      "      second subject",
      "      second detail",
      "      folded detail"
    ];
    expect(smartLog(lines)).toEqual([
      "* commit abc1234",
      "|     first subject",
      "|     first detail",
      "|     … 2 lines folded …",
      "* commit def5678",
      "      second subject",
      "      second detail",
      "      … 1 line folded …"
    ]);
  });

  it.each(["", "| "])("does not fold indented patch context for graph prefix %j", (prefix) => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      "     const before = 1;",
      "-    const value = 1;",
      "+    const value = 2;",
      "     const after = 3;"
    ].map((line) => `${prefix}${line}`);
    const lines = [
      `${prefix ? "* " : ""}commit abc1234`,
      `${prefix}    fix calculation`,
      `${prefix}    preserve adjacent context`,
      ...patch
    ];

    expect(smartLog(lines)).toEqual(lines);
  });
});
