import { describe, expect, it } from "vitest";
import { smartWc } from "../engine/transforms/smart-wc";
import { processOutput } from "../engine";

describe("smartWc", () => {
  it("states a shared folder once and keeps every count and the total", () => {
    const lines = [
      "     163 packages/plugin/src/engine/transforms/smart-ls.ts",
      "      78 packages/plugin/src/engine/transforms/smart-find.ts",
      "     241 total"
    ];
    expect(smartWc(lines)).toEqual(["in packages/plugin/src/engine/transforms/:", "163 smart-ls.ts", "78 smart-find.ts", "241 total"]);
  });

  it("keeps the deepest folder the files share", () => {
    const lines = ["  10 src/a/x.ts", "  20 src/b/y.ts", "  30 total"];
    expect(smartWc(lines)).toEqual(["in src/:", "10 a/x.ts", "20 b/y.ts", "30 total"]);
  });

  it("keeps paths as they are when nothing is shared", () => {
    expect(smartWc(["  1 a.ts", "  2 lib/b.ts", "  3 total"])).toEqual(["1 a.ts", "2 lib/b.ts", "3 total"]);
  });

  it("handles several columns and a single file", () => {
    expect(smartWc(["      12      40     310 src/a.ts", "       3       9      70 src/b.ts", "      15      49     380 total"])).toEqual([
      "in src/:",
      "12 40 310 a.ts",
      "3 9 70 b.ts",
      "15 49 380 total"
    ]);
    expect(smartWc(["     163 src/a.ts"])).toEqual(["163 src/a.ts"]);
  });

  it("leaves unexpected output untouched", () => {
    const lines = ["wc: missing.ts: No such file or directory", "  4 src/a.ts"];
    expect(smartWc(lines)).toEqual(lines);
  });

  it("is used for wc and keeps all files past thirty lines", async () => {
    const files = Array.from({ length: 40 }, (_, i) => `   ${i + 1} src/engine/file${i}.ts`);
    const result = await processOutput("wc -l src/engine/*.ts", [...files, "  820 total"].join("\n"), null, { exitCode: 0 });
    const lines = result.output.split("\n");
    expect(lines[0]).toBe("in src/engine/:");
    for (let i = 0; i < 40; i += 1) expect(lines).toContain(`${i + 1} file${i}.ts`);
    expect(lines).toContain("820 total");
  });
});
