import { describe, expect, it } from "vitest";
import { applyFilterWithTail } from "../engine/pipeline";
import { processOutput } from "../engine/index";
import { FilterDef } from "../engine/schema";
import type { LoadedFilter } from "../engine/loader";

function filter(over: Record<string, unknown>): LoadedFilter {
  const def = FilterDef.parse({ slug: "x", match_command: "^x", ...over });
  return { ...def, matchRegex: /^x/ };
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");

describe("applyFilterWithTail", () => {
  it("returns the dropped middle lines beyond the cap", () => {
    const r = applyFilterWithTail(lines(30), filter({ max_lines: 10 }), { verbosity: "normal" });
    expect(r.text.split("\n").filter((l) => l.startsWith("l")).length).toBe(10);
    expect(r.droppedTail).not.toBeNull();
    expect(r.droppedTail!.split("\n")).toContain("l7");
    expect(r.droppedTail!.split("\n")).toContain("l26");
    expect(r.droppedTail!.split("\n")).not.toContain("l0");
    expect(r.droppedTail!.split("\n")).not.toContain("l29");
  });
  it("returns null tail when nothing is dropped", () => {
    const r = applyFilterWithTail(lines(5), filter({ max_lines: 10 }), {});
    expect(r.droppedTail).toBeNull();
  });
  it("excludes kept-failure lines from the dropped tail", () => {
    const input = lines(10) + "\nError: boom\n" + lines(5);
    const r = applyFilterWithTail(input, filter({ max_lines: 5, keep_failures: true }), {});
    expect(r.text).toContain("Error: boom");
    expect(r.droppedTail ?? "").not.toContain("Error: boom");
  });
});

describe("processOutput", () => {
  it("keeps the original as the restore source when a failing run is stripped", async () => {
    const def = filter({ strip_on_failure: true, strip_lines_matching: ["^PASS "] });
    const input = `${Array.from({ length: 20 }, (_, i) => `PASS test ${i}`).join("\n")}\nFAIL test 20\n`;
    const r = await processOutput("x run", input, null, { exitCode: 1, resolver: async () => def });
    expect(r.output).toBe("FAIL test 20\n");
    expect(r.droppedTail).toBe(input);
  });
});
