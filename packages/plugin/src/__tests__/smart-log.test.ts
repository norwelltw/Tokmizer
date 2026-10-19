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

const hash = (n: number): string => `${n}`.repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, "f");
const plain = (n: number, bodyLines: number): string[] => [
  `commit ${hash(n)}`,
  "Author: Dev <dev@example.com>",
  "Date:   Thu Oct 8 18:00:00 2026 +0200",
  `    subject ${n}`,
  ...Array.from({ length: bodyLines }, (_, i) => `    body ${n}.${i}`)
];

describe("smartLog", () => {
  it("keeps every commit on one header line and its subject, and folds the rest", () => {
    const lines = [...plain(1, 6), ...plain(2, 0), ...plain(3, 1)];
    const out = smartLog(lines);
    expect(out.slice(0, 2)).toEqual(["author: Dev <dev@example.com>", "dates: UTC+0200"]);
    for (const n of [1, 2, 3]) {
      expect(out).toContain(`${hash(n).slice(0, 12)} 2026-10-08 18:00`);
      expect(out).toContain(`    subject ${n}`);
    }
    expect(out.some((l) => l.startsWith("commit ") || l.startsWith("Author:") || l.startsWith("Date:"))).toBe(false);
    expect(out).not.toContain("    body 1.0");
    expect(out).toContain("    … 6 lines folded …");
    expect(out).toContain("    … 1 line folded …");
    expect(out.filter((l) => FOLD_MARKER_RE.test(l))).toHaveLength(2);
  });

  it("leaves stat and diff lines untouched", () => {
    const lines = [...plain(1, 0), " src/a.ts | 3 ++-", " 1 file changed, 2 insertions(+), 1 deletion(-)"];
    expect(smartLog(lines)).toEqual([
      `${hash(1).slice(0, 12)} 2026-10-08 18:00 +0200 Dev <dev@example.com>`,
      "    subject 1",
      " src/a.ts | 3 ++-",
      " 1 file changed, 2 insertions(+), 1 deletion(-)"
    ]);
  });

  it("keeps each author when they differ, and merge parents and decorations", () => {
    const lines = [
      `commit ${hash(1)} (HEAD -> main, origin/main)`,
      "Merge: abc1234 def5678",
      "Author: Ann <ann@example.com>",
      "Date:   Mon Jan 5 09:03:00 2026 -0500",
      "    merge feature",
      `commit ${hash(2)}`,
      "Author: Bob <bob@example.com>",
      "Date:   Tue Feb 17 23:59:59 2026 +0000",
      "    fix"
    ];
    expect(smartLog(lines)).toEqual([
      `${hash(1).slice(0, 12)} 2026-01-05 09:03 -0500 Ann <ann@example.com> merge abc1234 def5678 (HEAD -> main, origin/main)`,
      "    merge feature",
      `${hash(2).slice(0, 12)} 2026-02-17 23:59 +0000 Bob <bob@example.com>`,
      "    fix"
    ]);
  });

  it("names a few alternating authors once in a legend", () => {
    const by = (n: number, who: string): string[] => [`commit ${hash(n)}`, `Author: ${who}`, "Date:   Thu Oct 8 18:00:00 2026 +0200", `    change ${n}`];
    const ann = "Ann <ann@example.com>";
    const bob = "Bob <bob@example.com>";
    const out = smartLog([...by(1, ann), ...by(2, bob), ...by(3, ann)]);
    expect(out).toEqual([
      `authors: [1] ${ann}; [2] ${bob}`,
      "dates: UTC+0200",
      `${hash(1).slice(0, 12)} 2026-10-08 18:00 [1]`,
      "    change 1",
      `${hash(2).slice(0, 12)} 2026-10-08 18:00 [2]`,
      "    change 2",
      `${hash(3).slice(0, 12)} 2026-10-08 18:00 [1]`,
      "    change 3"
    ]);
  });

  it("leaves headers alone when a date is not in git's default format", () => {
    const lines = [`commit ${hash(1)}`, "Author: Dev <dev@example.com>", "Date:   2026-10-08T18:00:00+02:00", "    subject"];
    expect(smartLog(lines)).toEqual(lines);
  });

  it("leaves one-line and custom formats alone", () => {
    const lines = ["abc1234 fix one", "def5678 fix two"];
    expect(smartLog(lines)).toEqual(lines);
  });

  it("treats deeper-indented continuation lines as part of the message", () => {
    const lines = [...commit(1, 1), "    - first bullet", "      wrapped continuation", "    - second bullet"];
    const out = smartLog(lines);
    expect(out).toContain("    … 4 lines folded …");
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
