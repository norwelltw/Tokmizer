import { afterEach, describe, expect, it } from "vitest";
import { processOutput, setFilterResolver } from "../engine";
import { FilterDef } from "../engine/schema";
import { compactRepeatedDiagnostics } from "../engine/repeated-diagnostics";

afterEach(() => setFilterResolver(null));

const diagnostic = "ERROR invoice total mismatch\nExpected 42; received 0\nsrc/payment.ts:18:9\n    at calculate (src/payment.ts:18:9)\nDEBUG expected value must remain visible\n";
const progress = "INFO waiting for the dependency resolver\n";

function useFilter(preserve_exact = false) {
  const def = FilterDef.parse({ slug: "npm-test", match_command: ".*", preserve_exact, strip_lines_matching: [".*"], max_lines: 1 });
  setFilterResolver(async () => ({ ...def, matchRegex: /.*/ }));
}

describe("Max repeated diagnostic output", () => {
  it.each([1, undefined])("summarizes exact consecutive log repetitions while keeping every distinct diagnostic, exit %s", async (exitCode) => {
    useFilter();
    const input = progress.repeat(100) + diagnostic + "\n\n" + progress.repeat(50) + "ERROR final failure\n";
    const result = await processOutput("npm test", input, null, { verbosity: "minimal", exitCode });
    expect(result.output).toContain(diagnostic + "\n\n");
    expect(result.output).toContain("ERROR final failure\n");
    expect(result.output.indexOf(diagnostic)).toBeLessThan(result.output.indexOf("ERROR final failure"));
    expect(result.output).toContain("99 additional times");
    expect(result.output).toContain("49 additional times");
    expect(result.filteredBytes).toBeLessThan(result.rawBytes / 4);
    expect(result.debugBypass).toBe(true);
    expect(result.droppedTail).toBe(input);
  });

  it.each(["normal", "compact"] as const)("keeps the complete failure output in %s", async (verbosity) => {
    useFilter();
    const input = progress.repeat(100) + diagnostic;
    expect((await processOutput("npm test", input, null, { verbosity, exitCode: 1 })).output).toBe(input);
  });

  it.each([
    "INFO waiting attempt 1\nINFO waiting attempt 2\nERROR failed\n",
    "2026-10-11T08:00:00Z INFO waiting\n2026-10-11T08:00:01Z INFO waiting\nERROR failed\n",
    "ERROR\nERROR\nERROR\n",
    "same expected value\nsame expected value\nsame expected value\nERROR failed\n",
    "INFO line\nERROR unique A\nINFO line\nERROR unique B\nINFO line\n",
    'export function run() {\n  const input = `\nINFO waiting\nINFO waiting\nINFO waiting\n`;\n}\n'
  ])("does not combine different events, data or short runs: %j", async (input) => {
    useFilter();
    expect((await processOutput("npm test", input, null, { verbosity: "minimal", exitCode: 1 })).output).toBe(input);
  });

  it("preserves exact-filter failures even with repeated logs", async () => {
    useFilter(true);
    const input = progress.repeat(100) + diagnostic;
    expect((await processOutput("npm test", input, null, { verbosity: "minimal", exitCode: 1 })).output).toBe(input);
  });

  it("does not apply the Max failure representation in YOLO", async () => {
    useFilter();
    const result = await processOutput("npm test", progress.repeat(100) + diagnostic, null, { verbosity: "minimal", exitCode: 1, yolo: true });
    expect(result.filteredBytes).toBeLessThanOrEqual(256);
    expect(result.output).not.toContain("additional times");
    expect(result.droppedTail).toBeNull();
  });
});

describe("exact log repetition accounting", () => {
  it.each(["\n", "\r\n"])("reconstructs the original events, counts and whitespace with %j", (newline) => {
    const rows = [
      ...Array<string>(120).fill("INFO résolution en cours 😀  "),
      "ERROR unique diagnostic",
      "  Expected: 42",
      "  Received: 0",
      ...Array<string>(32).fill("2026-10-11T08:00:00Z WARNING temporary outage"),
      "2026-10-11T08:00:01Z WARNING temporary outage",
      "",
      ""
    ];
    const input = rows.join(newline);
    const output = compactRepeatedDiagnostics(input);
    const restored: string[] = [];
    for (const line of output.split("\n")) {
      const count = /^\[tkr: previous log line repeated (\d+) additional times\]$/.exec(line);
      if (count) restored.push(...Array<string>(Number(count[1])).fill(restored.at(-1)!));
      else restored.push(line);
    }
    expect(restored.join("\n")).toBe(input);
    expect(Buffer.byteLength(output)).toBeLessThan(Buffer.byteLength(input) / 4);
  });

  it("keeps literal repetition markers unchanged to avoid ambiguous counts", () => {
    const input = progress.repeat(100) + "[tkr: previous log line repeated 12 additional times]\n" + diagnostic;
    expect(compactRepeatedDiagnostics(input)).toBe(input);
  });

  it("preserves long source code containing log-shaped string literals", () => {
    const input = 'export const fixture = `\n' + progress.repeat(100) + '`;\n';
    expect(compactRepeatedDiagnostics(input)).toBe(input);
  });
});
