import { afterEach, describe, expect, it } from "vitest";
import { processOutput, selectFilter, setFilterResolver } from "../engine";
import { FilterDef } from "../engine/schema";
import { __resetMatcherCache } from "../engine/matcher";

function useFilter(options: Partial<FilterDef> = {}): void {
  const def = FilterDef.parse({ slug: "yolo-test", match_command: "^demo$", ...options });
  const filter = { ...def, matchRegex: new RegExp(def.match_command) };
  setFilterResolver(async (cmd, allowed) => selectFilter(cmd, [filter], allowed));
}

afterEach(() => {
  setFilterResolver(null);
  __resetMatcherCache();
});

describe("YOLO output", () => {
  it("caps long output more aggressively than minimal only when enabled", async () => {
    useFilter();
    const input = Array.from({ length: 100 }, (_, i) => `record ${i}: useful diagnostic details`).join("\n");
    const normal = await processOutput("demo", input, null);
    const disabled = await processOutput("demo", input, null, { yolo: false });
    const minimal = await processOutput("demo", input, null, { verbosity: "minimal" });
    const enabled = await processOutput("demo", input, null, { yolo: true });

    expect(normal.output).toBe(input);
    expect(disabled).toEqual(normal);
    expect(enabled.filteredBytes).toBeLessThan(minimal.filteredBytes);
    expect(enabled.filteredBytes).toBeLessThanOrEqual(256);
    expect(enabled.filteredBytes).toBe(Buffer.byteLength(enabled.output, "utf8"));
    expect(enabled.rawBytes).toBe(Buffer.byteLength(input, "utf8"));
    expect(enabled.output).toMatch(/^record 0:/);
    expect(enabled.output).toContain("[YOLO: omitted]");
    expect(enabled.output).toMatch(/record 99: useful diagnostic details$/);
    expect(enabled.droppedTail).toBeNull();
  });

  it("forces minimal verbosity even when normal verbosity is requested", async () => {
    useFilter();
    const input = "[INFO] preparing a command with detailed dependency resolution metadata\nresult: ready\n";

    const normal = await processOutput("demo", input, null, { verbosity: "normal" });
    const enabled = await processOutput("demo", input, null, { verbosity: "normal", yolo: true });

    expect(normal.output).toContain("[INFO]");
    expect(enabled.output).not.toContain("[INFO]");
    expect(enabled.output).toContain("result: ready");
  });

  it.each(["😀", "é", "漢", "é😀漢"])("keeps UTF-8 intact at both ends for %s", async (unit) => {
    useFilter();
    const input = `start:${unit.repeat(200)}:finish`;

    const result = await processOutput("demo", input, null, { yolo: true });
    const [head, tail] = result.output.split("\n[YOLO: omitted]\n");

    expect(result.filteredBytes).toBeLessThanOrEqual(256);
    expect(result.output).not.toContain("\uFFFD");
    expect(Buffer.from(result.output, "utf8").toString("utf8")).toBe(result.output);
    expect(head).toBeTruthy();
    expect(tail).toBeTruthy();
    expect(input.startsWith(head!)).toBe(true);
    expect(input.endsWith(tail!)).toBe(true);
  });

  it.each(["", "ok\n", "😀".repeat(64), "x".repeat(256)])("keeps an output within the byte budget intact: %j", async (input) => {
    useFilter();

    const result = await processOutput("demo", input, null, { yolo: true });

    expect(result.output).toBe(input);
    expect(result.filteredBytes).toBe(Buffer.byteLength(input, "utf8"));
    expect(result.droppedTail).toBeNull();
  });

  it("still caps output when the preceding filter would expand it", async () => {
    useFilter({ max_lines: 1 });
    const input = `${"x".repeat(260)}\ny`;

    const minimal = await processOutput("demo", input, null, { verbosity: "minimal" });
    const result = await processOutput("demo", input, null, { yolo: true });

    expect(minimal.output).toBe(input);
    expect(result.filteredBytes).toBeLessThanOrEqual(256);
    expect(result.filteredBytes).toBeLessThan(result.rawBytes);
    expect(result.output).toContain("[YOLO: omitted]");
  });

  it("does not expand short output even when minimal adds a summary", async () => {
    useFilter();

    const result = await processOutput("demo", "x\nx\n", null, { yolo: true });

    expect(result.output).toBe("x\nx\n");
    expect(result.filteredBytes).toBe(result.rawBytes);
  });

  it.each(["", " "])("does not expand output with an on-empty replacement: %j", async (input) => {
    useFilter({ on_empty: "build: ok" });

    const result = await processOutput("demo", input, null, { exitCode: 0, yolo: true });

    expect(result.output).toBe(input);
    expect(result.filteredBytes).toBeLessThanOrEqual(result.rawBytes);
  });

  it("retains a nonempty excerpt when a filter removes every line", async () => {
    useFilter({ strip_lines_matching: [".*"] });

    const result = await processOutput("demo", "important output\n", null, { yolo: true });

    expect(result.output).toBe("important output\n");
    expect(result.filteredBytes).toBeGreaterThan(0);
  });

  it.each([0, 2])("only overrides preserve_exact when enabled for exit code %i", async (exitCode) => {
    useFilter({ preserve_exact: true });
    const input = `ERROR: start\n${"exact record\n".repeat(100)}ERROR: end`;

    const normal = await processOutput("demo", input, null, { exitCode });
    const disabled = await processOutput("demo", input, null, { exitCode, yolo: false });
    const enabled = await processOutput("demo", input, null, { exitCode, yolo: true });

    expect(normal.output).toBe(input);
    expect(disabled).toEqual(normal);
    expect(enabled.output).toMatch(/^ERROR: start/);
    expect(enabled.output).toMatch(/ERROR: end$/);
    expect(enabled.filteredBytes).toBeLessThanOrEqual(256);
    expect(enabled.droppedTail).toBeNull();
  });

  it("keeps failed-command evidence at both ends with a bounded diagnostic", async () => {
    useFilter({ max_lines: 1, on_empty: "build: ok" });
    const input = `ERROR: compilation failed\n${Array.from({ length: 100 }, (_, i) => `diagnostic ${i}`).join("\n")}\nFATAL: build aborted`;

    const result = await processOutput("demo", input, null, { exitCode: 2, yolo: true });

    expect(result.output).toMatch(/^ERROR: compilation failed/);
    expect(result.output).toMatch(/FATAL: build aborted$/);
    expect(result.output).not.toContain("build: ok");
    expect(result.debugBypass).toBe(true);
    expect(result.filteredBytes).toBeLessThanOrEqual(256);
    expect(result.droppedTail).toBeNull();
  });

  it.each(["", "\u001b[0m"])("does not invent success for empty failed output: %j", async (input) => {
    useFilter({ strip_ansi: true, on_empty: "build: ok" });

    const result = await processOutput("demo", input, null, { exitCode: 2, yolo: true });

    expect(result.output).not.toContain("build: ok");
    expect(result.filteredBytes).toBeLessThanOrEqual(result.rawBytes);
    expect(result.debugBypass).toBe(true);
    expect(result.droppedTail).toBeNull();
  });

  it.each(["unmatched", "forbidden"])("does not compress when the filter is %s", async (kind) => {
    useFilter();
    const input = "untouched output ".repeat(200);
    const cmd = kind === "unmatched" ? "other" : "demo";
    const allowed = kind === "forbidden" ? new Set<string>() : null;

    const result = await processOutput(cmd, input, allowed, { yolo: true });

    expect(result.output).toBe(input);
    expect(result.filterId).toBeNull();
    expect(result.filteredBytes).toBe(result.rawBytes);
    expect(result.droppedTail).toBeNull();
  });

  it("discards restoration data created by an earlier line cap", async () => {
    useFilter({ max_lines: 20 });
    const input = Array.from({ length: 100 }, (_, i) => `line ${i}: retained detail`).join("\n");

    const normal = await processOutput("demo", input, null);
    const enabled = await processOutput("demo", input, null, { yolo: true });

    expect(normal.droppedTail).toContain("line 50:");
    expect(enabled.droppedTail).toBeNull();
    expect(enabled.filteredBytes).toBeLessThanOrEqual(256);
  });
});
