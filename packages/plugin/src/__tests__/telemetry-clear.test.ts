import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStats } from "../stats";
import { clearUsage } from "../usage";

describe("tkr telemetry forget — local store clear", () => {
  it("clearStats removes the file and returns the record count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-stats-"));
    const f = join(dir, "stats.jsonl");
    writeFileSync(f, '{"t":1,"r":100,"f":40}\n{"t":2,"r":50,"f":20}\n');
    const n = await clearStats(f);
    expect(n).toBe(2);
    expect(existsSync(f)).toBe(false);
  });

  it("clearStats returns 0 when the file is absent", async () => {
    const n = await clearStats(join(tmpdir(), "tkr-absent-stats", "stats.jsonl"));
    expect(n).toBe(0);
  });

  it("clearUsage removes the file and returns the record count", () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-usage-"));
    const f = join(dir, "usage.jsonl");
    writeFileSync(f, '{"t":1,"s":"a","o":1}\n{"t":2,"s":"a","o":0}\n{"t":3,"s":"a","o":1}\n');
    const n = clearUsage(f);
    expect(n).toBe(3);
    expect(existsSync(f)).toBe(false);
  });

  it("clearUsage returns 0 when the file is absent", () => {
    expect(clearUsage(join(tmpdir(), "tkr-absent-usage", "usage.jsonl"))).toBe(0);
  });
});
