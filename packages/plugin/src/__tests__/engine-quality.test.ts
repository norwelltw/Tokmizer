import { afterEach, describe, expect, it } from "vitest";
import { processOutput, setFilterResolver } from "../engine";
import { FilterDef } from "../engine/schema";
import { applyFilterWithTail } from "../engine/pipeline";
import { truncateLinesAt } from "../engine/transforms/truncate-lines";

afterEach(() => setFilterResolver(null));

describe("compression benefit", () => {
  it("preserves literal fold markers and spacing when no transform is enabled", () => {
    const input = "… 3 lines folded …\n\n\nnext";
    const def = FilterDef.parse({ slug: "test", match_command: ".*" });
    expect(applyFilterWithTail(input, def)).toEqual({ text: input, droppedTail: null });
  });

  it.each(["x\nx\nx\n", "ab\nab\nab\n", "😀\n😀\n😀\n"])("keeps a short output when its summary would be larger: %j", async (input) => {
    const def = FilterDef.parse({ slug: "test", match_command: ".*", transform: "squeeze-output" });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const result = await processOutput("demo", input, null, { exitCode: 0 });
    expect(result.output).toBe(input);
    expect(result.filteredBytes).toBe(result.rawBytes);
    expect(result.droppedTail).toBeNull();
  });

  it("still compresses long repeated output", async () => {
    const def = FilterDef.parse({ slug: "test", match_command: ".*", transform: "squeeze-output" });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const input = "Downloading unchanged dependencies\n".repeat(100);
    const result = await processOutput("demo", input, null, { exitCode: 0 });
    expect(result.output).toContain("repeated 100x");
    expect(result.filteredBytes).toBeLessThan(result.rawBytes / 10);
  });
});

describe("failed command output", () => {
  it.each(["", "\u001b[0m"])("does not invent a successful result for a failed command: %j", async (input) => {
    const def = FilterDef.parse({ slug: "test", match_command: ".*", strip_ansi: true, on_empty: "build: ok" });
    setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
    const result = await processOutput("build", input, null, { exitCode: 2 });
    expect(result.output).not.toContain("ok");
    expect(result.debugBypass).toBe(true);
  });
});

describe("honest omission accounting", () => {
  it("counts only the discarded lines when keeping errors after the cap", () => {
    const def = FilterDef.parse({ slug: "test", match_command: ".*", max_lines: 2, keep_failures: true });
    const result = applyFilterWithTail("a\nb\nc\nERROR: keep\nd", def);
    expect(result.text).toContain("(2 more lines omitted)");
    expect(result.text).toContain("ERROR: keep");
    expect(result.droppedTail).toBe("c\nd");
  });

  it("does not claim omissions when every remaining line is retained", () => {
    const def = FilterDef.parse({ slug: "test", match_command: ".*", max_lines: 2, keep_failures: true });
    const result = applyFilterWithTail("a\nb\nERROR: first\nERROR: second", def);
    expect(result.text).toBe("a\nb\nERROR: first\nERROR: second");
    expect(result.droppedTail).toBeNull();
  });
});

describe("Unicode truncation", () => {
  it.each([
    ["aaa😀xyz", 4, "aaa…"],
    ["aaa😀xyz", 5, "aaa😀…"],
    ["éé😀xyz", 3, "éé…"],
    ["abc", 3, "abc"]
  ] as const)("does not split a surrogate pair: %j at %i", (input, width, expected) => {
    expect(truncateLinesAt([input], width)).toEqual([expected]);
  });
});
