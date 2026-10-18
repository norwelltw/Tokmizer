import { describe, expect, it } from "vitest";
import { extractBashRuns, aggregateReplay } from "../replay-bench";
import { coverageSummary } from "../stats";
import type { GainAgg } from "../stats";

function useLine(id: string, command: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: "u-" + id,
    message: {
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }]
    }
  });
}

function resultLine(id: string, stdout: string, stderr = ""): string {
  return JSON.stringify({
    type: "user",
    uuid: "r-" + id,
    message: {
      content: [{ type: "tool_result", tool_use_id: id }]
    },
    toolUseResult: {
      stdout,
      stderr,
      interrupted: false,
      isImage: false,
      noOutputExpected: false
    }
  });
}

describe("extractBashRuns", () => {
  it("pairs Bash tool_use commands with their toolUseResult outputs", () => {
    const jsonl = [
      useLine("t1", "git status"),
      resultLine("t1", "On branch master\n"),
      useLine("t2", "cargo build"),
      resultLine("t2", "Compiling foo\n", "warning: unused\n")
    ].join("\n");
    const runs = extractBashRuns(jsonl);
    expect(runs).toEqual([
      { command: "git status", output: "On branch master\n" },
      { command: "cargo build", output: "Compiling foo\nwarning: unused\n" }
    ]);
  });

  it("ignores non-Bash tools, unmatched results and malformed lines", () => {
    const readUse = JSON.stringify({
      message: { content: [{ type: "tool_use", id: "t9", name: "Read", input: { file_path: "/x" } }] }
    });
    const jsonl = [
      readUse,
      resultLine("t9", "file body"),
      resultLine("orphan", "no matching use"),
      "{not json",
      useLine("t3", "ls -la"),
      resultLine("t3", "total 8\n")
    ].join("\n");
    expect(extractBashRuns(jsonl)).toEqual([{ command: "ls -la", output: "total 8\n" }]);
  });
});

describe("aggregateReplay", () => {
  it("groups by command label, splits routed vs passthrough and ranks lost tokens", () => {
    const report = aggregateReplay([
      { command: "psql -c select", rawBytes: 4000, filteredBytes: 4000, filterId: null },
      { command: "psql -c other", rawBytes: 8000, filteredBytes: 8000, filterId: null },
      { command: "git status", rawBytes: 2000, filteredBytes: 400, filterId: "git" }
    ]);
    expect(report.totals.runs).toBe(3);
    expect(report.totals.routedPct).toBeCloseTo((1 / 3) * 100, 5);
    expect(report.rows[0]).toMatchObject({ label: "psql", runs: 2, routed: 0, lostTokens: 3000 });
    expect(report.rows[1]).toMatchObject({ label: "git status", runs: 1, routed: 1, savedTokens: 400 });
  });
});

describe("coverageSummary", () => {
  it("reports overall compressed share and the top uncovered labels", () => {
    const agg = {
      count: 10,
      compressedCount: 7,
      rawTokens: 0,
      filteredTokens: 0,
      savedTokens: 0,
      byCommand: [
        { cmd: "psql", count: 4, compressedCount: 0, savedTokens: 0, avgPct: 0, native: false },
        { cmd: "git", count: 5, compressedCount: 5, savedTokens: 10, avgPct: 50, native: false },
        { cmd: "vitest", count: 1, compressedCount: 0, savedTokens: 0, avgPct: 0, native: false }
      ]
    } as unknown as GainAgg;
    const line = coverageSummary(agg);
    expect(line).toContain("70%");
    expect(line).toContain("psql");
    expect(line).toContain("vitest");
  });

  it("returns null when there is no data", () => {
    const agg = { count: 0, compressedCount: 0, byCommand: [] } as unknown as GainAgg;
    expect(coverageSummary(agg)).toBeNull();
  });
});
