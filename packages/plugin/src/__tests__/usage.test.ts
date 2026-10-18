import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordUsageSync, readSession, renderSession } from "../usage";

const MAX_LINES = 20000;

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "tkr-usage-")), "usage.jsonl");
}

describe("session usage", () => {
  it("counts the latest session's total + routed", () => {
    const f = tmpFile();
    recordUsageSync("sessA", true, f);
    recordUsageSync("sessA", false, f);
    recordUsageSync("sessB", true, f);
    recordUsageSync("sessB", true, f);
    recordUsageSync("sessB", false, f);
    const s = readSession(f);
    expect(s.sessionId).toBe("sessB");
    expect(s.total).toBe(3);
    expect(s.routed).toBe(2);
    expect(s.pct).toBe(67);
  });

  it("empty/missing file -> zeros", () => {
    const s = readSession(tmpFile());
    expect(s.total).toBe(0);
    expect(s.sessionId).toBeNull();
  });

  it("renderSession is value-only, no mechanism leak", () => {
    const out = renderSession({ sessionId: "x", total: 12, routed: 11, pct: 92 });
    expect(out).toContain("handled by tkr");
    expect(out).not.toMatch(/filter/i);
    expect(renderSession({ sessionId: null, total: 0, routed: 0, pct: 0 })).toContain("No commands yet");
  });

  it("returns the latest session even when earlier sessions exist", () => {
    const f = tmpFile();
    recordUsageSync("old1", true, f);
    recordUsageSync("old1", false, f);
    recordUsageSync("old2", true, f);
    recordUsageSync("latest", true, f);
    recordUsageSync("latest", true, f);
    recordUsageSync("latest", false, f);
    const s = readSession(f);
    expect(s.sessionId).toBe("latest");
    expect(s.total).toBe(3);
    expect(s.routed).toBe(2);
  });

  it("caps the aggregate to the last MAX_LINES without rewriting the file (concurrent-append safe)", () => {
    const f = tmpFile();
    const lines: string[] = [];
    for (let i = 0; i < MAX_LINES + 300; i += 1) {
      lines.push(`{"t":${1700000000 + i},"s":"only","o":${i % 2}}`);
    }
    writeFileSync(f, lines.join("\n") + "\n");
    const s = readSession(f);
    expect(s.sessionId).toBe("only");
    expect(s.total).toBe(MAX_LINES);
    const after = readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "");
    expect(after.length).toBe(MAX_LINES + 300);
  });
});
