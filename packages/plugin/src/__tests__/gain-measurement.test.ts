import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedSaving, readDaily, readGain, recordStat, renderDaily, renderGain } from "../stats";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-measurement-"));
  file = join(dir, "stats.jsonl");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("gain measurement boundaries", () => {
  it("separates reduced-output efficiency from the weighted observed total", async () => {
    recordStat(1000, 100, file);
    recordStat(5000, 5000, file);
    const gain = await readGain(file);
    expect(gain.savedPct).toBe(90);
    expect(gain.rawTokens).toBe(250);
    expect(gain.observed).toMatchObject({ count: 2, rawTokens: 1500, filteredTokens: 1275, savedTokens: 225, savedPct: 15 });
    expect(gain.measurement).toMatchObject({ tokenCounts: "estimated", tokenMethod: "bytes/4", billing: "not-measured" });
  });

  it("retains expansion and zero-input overhead in the net result", async () => {
    recordStat(400, 40, file);
    recordStat(100, 200, file);
    recordStat(0, 400, file);
    const gain = await readGain(file);
    expect(gain.observed).toMatchObject({ count: 3, rawTokens: 125, filteredTokens: 160, savedTokens: -35, savedPct: -28, expandedCount: 2 });
    expect(gain.compressedCount).toBe(1);
  });

  it("ranks commands on the same agent scope as the total", async () => {
    recordStat(4000, 400, file, false, "claude", "sh", "cat");
    recordStat(8000, 800, file, false, "shell", "sh", "cat");
    recordStat(9000, 900, file, false, "shell", "sh", "grep");
    const gain = await readGain(file);
    expect(gain.byCommand).toEqual([expect.objectContaining({ cmd: "cat", count: 1, savedTokens: 900 })]);
    expect(gain.agent).toMatchObject({ count: 1, rawTokens: 1000, filteredTokens: 100 });
  });

  it("keeps filtered growth visible when applying a host cap", () => {
    expect(countedSaving(100, 150, null)).toEqual({ raw: 100, filtered: 150 });
    expect(countedSaving(100, 150, 120)).toEqual({ raw: 100, filtered: 120 });
  });

  it("rejects invalid numeric records instead of poisoning totals", async () => {
    recordStat(Number.NaN, 0, file);
    recordStat(Infinity, 0, file);
    recordStat(1, Number.NaN, file);
    recordStat(10, -1, file);
    recordStat(400, 100, file);
    const gain = await readGain(file);
    expect(gain.count).toBe(1);
    expect(gain.observed?.savedTokens).toBe(75);
  });

  it("keeps modeled reducer estimates outside daily measured totals and dates", async () => {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(file, [
      { t: now - 86400 * 100, r: 8000, f: 4000, m: 1 },
      { t: now - 3600, r: 400, f: 40 },
      { t: now, r: 100, f: 200 }
    ].map((record) => JSON.stringify(record)).join("\n"));
    const gain = await readGain(file);
    expect(gain.modeledSavedTokens).toBe(1000);
    expect(gain.window).toEqual({ firstAt: now - 3600, lastAt: now });
    expect(gain.sinceDays).toBe(1);
    const days = await readDaily(file);
    expect(days.reduce((sum, day) => sum + day.savedTokens, 0)).toBe(65);
    expect(days.reduce((sum, day) => sum + day.count, 0)).toBe(2);
  });

  it("counts every journal record instead of a latest-20000 window", async () => {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(file, Array.from({ length: 20001 }, (_, i) => JSON.stringify({ t: now - 20001 + i, r: 40, f: 4 })).join("\n"));
    const gain = await readGain(file);
    expect(gain.count).toBe(20001);
    expect(gain.window).toEqual({ firstAt: now - 20001, lastAt: now - 1 });
  });
});

function seedRows(rows: Record<string, unknown>[]): void {
  writeFileSync(file, rows.map((record) => JSON.stringify(record)).join("\n"));
}

describe("gain panel", () => {
  it("adds the rate on shortened outputs only, leaving terminal commands out", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([
      { t: now, r: 4000, f: 400, h: "claude-code", k: "sh", c: "rg" },
      { t: now, r: 2000, f: 2000, h: "claude-code", k: "sh", c: "ls" },
      { t: now, r: 2000, f: 2000, h: "claude-code", k: "sh", c: "head" },
      { t: now, r: 8000, f: 800, h: "shell", k: "sh", c: "rg" }
    ]);
    const gain = await readGain(file);
    expect(gain.shortened).toEqual({ count: 1, rawTokens: 1000, filteredTokens: 100, savedPct: 90 });
    const output = renderGain(gain, { color: false, pricePerMtok: 3 });
    expect(output).toMatch(/Tokens saved\s+900 \(45 % of all commands\)/);
    expect(output).toMatch(/Shortened only\s+−90 % on the 1 output Tokmizer shortened/);
  });

  it("shows tokens in, out and saved for agent outputs with one efficiency figure", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([
      { t: now, r: 4000, f: 400, h: "claude-code", k: "sh", c: "rg" },
      { t: now, r: 2000, f: 2000, h: "claude-code", k: "sh", c: "ls" }
    ]);
    const output = renderGain(await readGain(file), { color: false, pricePerMtok: 3 });
    expect(output).toMatch(/Commands\s+2 · 1 reduced/);
    expect(output).toMatch(/Tokens in\s+1\.5K/);
    expect(output).toMatch(/Tokens out\s+600/);
    expect(output).toMatch(/Tokens saved\s+900 \(60 % of all commands\)/);
    expect(output).toMatch(/Efficiency\s+█+░+ 60 %/);
    expect(output).toMatch(/1\. rg\s+1\s+900\s+90 %/);
    expect(output).toContain("not provider-counted tokens");
  });

  it("names no plan, account or payback", async () => {
    seedRows([{ t: Math.floor(Date.now() / 1000), r: 4000, f: 400, h: "claude-code", k: "sh", c: "rg" }]);
    const output = renderGain(await readGain(file), { color: false, pricePerMtok: 3 });
    expect(output).not.toMatch(/\bpro\b|smart|plan|Account|Pays for itself/i);
  });

  it("does not round a fraction of a dollar up to one dollar", async () => {
    recordStat(800000, 340000, file);
    const output = renderGain(await readGain(file), { color: false, pricePerMtok: 3 });
    expect(output).toMatch(/API value\s+\$0\.35 at \$3\.00\/M input tokens/);
  });

  it("reports a net expansion as tokens added, never as a reduction", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([{ t: now, r: 100, f: 400, h: "claude-code", k: "sh", c: "ls" }]);
    const output = renderGain(await readGain(file), { color: false, pricePerMtok: 3 });
    expect(output).toMatch(/Tokens added\s+75 \(300 % of all commands\)/);
    expect(output).toMatch(/Efficiency\s+░+ 0 %/);
    expect(output).not.toContain("Tokens saved");
  });

  it("deducts restorations and keeps the reducer estimate out of the totals", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([
      { t: now, r: 4000, f: 400, h: "claude-code", k: "sh", c: "cat" },
      { t: now, r: 0, f: 400, h: "claude-code", k: "restore", c: "tkr restore" },
      { t: now, r: 8000, f: 4000, m: 1 }
    ]);
    const output = renderGain(await readGain(file), { color: false, pricePerMtok: 3 });
    expect(output).toMatch(/Tokens saved\s+800 /);
    expect(output).toMatch(/Restored\s+100 tokens, deducted/);
    expect(output).toMatch(/Reducer \(est\.\)\s+1\.0K tokens, not included/);
  });

  it("deducts a restoration run from a plain terminal, so the header and --json agree on the net figure", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([
      { t: now, r: 4000, f: 400, h: "claude-code", k: "sh", c: "cat" },
      { t: now, r: 0, f: 2000, h: "shell", k: "restore", c: "tkr restore" }
    ]);
    const gain = await readGain(file);
    expect(gain.observed?.savedTokens).toBe(400);
    expect(gain.agent).toEqual({ count: 2, rawTokens: 1000, filteredTokens: 600, savedPct: 40 });
    expect(gain.terminal).toEqual({ count: 0, rawTokens: 0, savedTokens: 0 });
    expect(gain.restoration).toEqual({ count: 1, tokens: 500 });
    const output = renderGain(gain, { color: false, pricePerMtok: 3 });
    expect(output).toMatch(/Tokens saved\s+400 \(40 % of all commands\)/);
    expect(output).toMatch(/Restored\s+500 tokens, deducted · 1 restore/);
    expect(output).not.toContain("terminal commands with no agent");
  });

  it("leaves terminal commands with no agent out of the totals and says so", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([
      { t: now, r: 4000, f: 400, h: "claude-code", k: "sh", c: "rg" },
      { t: now, r: 20000, f: 20000, h: "shell", k: "sh", c: "cat" }
    ]);
    const gain = await readGain(file);
    expect(gain.agent).toEqual({ count: 1, rawTokens: 1000, filteredTokens: 100, savedPct: 90 });
    expect(gain.terminal).toEqual({ count: 1, rawTokens: 5000, savedTokens: 0 });
    const output = renderGain(gain, { color: false, pricePerMtok: 3 });
    expect(output).toMatch(/Tokens in\s+1\.0K/);
    expect(output).toContain("1 terminal commands with no agent are not counted.");
  });

  it("labels a period that grew outputs as added, never as negative savings", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([{ t: now, r: 4000, f: 400, h: "claude-code", k: "sh", c: "rg" }]);
    const output = renderGain(await readGain(file), {
      color: false,
      pricePerMtok: 3,
      periods: [{ label: "Today", savedTokens: -35, count: 50 }, { label: "Last 7 days", savedTokens: 900, count: 51 }]
    });
    expect(output).toMatch(/Today\s+35 added · 50 commands/);
    expect(output).toMatch(/Last 7 days\s+900 saved · 51 commands/);
    expect(output).not.toContain("-35");
  });

  it("labels a day that grew outputs as added in the daily table", () => {
    const table = renderDaily([{ day: "2026-10-15", count: 50, savedTokens: -35 }], { color: false });
    expect(table).toContain("35 added");
    expect(table).not.toContain("-35");
  });

  it("leaves Bash outputs larger than Claude Code's 30,000-character limit out of the totals, like rtk", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([
      { t: now, r: 4000, f: 400, h: "claude-code", k: "sh", c: "rg" },
      { t: now, r: 400000, f: 4000, h: "claude-code", k: "sh", c: "cat" },
      { t: now, r: 200000, f: 20000, h: "claude-code", c: "Read" }
    ]);
    const gain = await readGain(file);
    expect(gain.oversizedExcluded).toBe(1);
    expect(gain.agent).toMatchObject({ count: 2, rawTokens: 51000, filteredTokens: 5100 });
    expect(gain.byCommand?.find((row) => row.cmd === "cat")).toBeUndefined();
    const tableSaved = (gain.byCommand ?? []).reduce((sum, row) => sum + row.savedTokens, 0);
    expect(tableSaved).toBeLessThanOrEqual((gain.agent?.rawTokens ?? 0) - (gain.agent?.filteredTokens ?? 0));
    const output = renderGain(gain, { color: false, pricePerMtok: 3 });
    expect(output).not.toMatch(/^\s+\d+\. cat\b/m);
    expect(output).toMatch(/Commands\s+2 · 2 reduced/);
    expect(output).toContain("1 Bash outputs over 30,000 characters are not counted: Claude Code shows at most that much.");
    expect((await readDaily(file)).reduce((sum, day) => sum + day.count, 0)).toBe(2);
  });

  it("counts a Bash output of exactly 30,000 characters", async () => {
    seedRows([{ t: Math.floor(Date.now() / 1000), r: 30000, f: 3000, h: "claude-code", k: "sh", c: "cat" }]);
    const gain = await readGain(file);
    expect(gain.oversizedExcluded).toBe(0);
    expect(gain.agent?.count).toBe(1);
  });

  it("still shows a panel when every output was oversized", async () => {
    seedRows([{ t: Math.floor(Date.now() / 1000), r: 400000, f: 4000, h: "claude-code", k: "sh", c: "cat" }]);
    const output = renderGain(await readGain(file), { color: false, pricePerMtok: 3 });
    expect(output).not.toContain("No data yet");
    expect(output).toContain("1 Bash outputs over 30,000 characters are not counted");
  });

  it("hides the command table when nothing was saved", async () => {
    seedRows([{ t: Math.floor(Date.now() / 1000), r: 2000, f: 2000, h: "claude-code", k: "sh", c: "ls" }]);
    const output = renderGain(await readGain(file), { color: false, pricePerMtok: 3 });
    expect(output).not.toContain("By command");
  });

  it("keeps the reduction when reduced in the per-command data", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedRows([
      { t: now, r: 4000, f: 400, h: "claude-code", k: "sh", c: "cat" },
      { t: now, r: 4000, f: 4000, h: "claude-code", k: "sh", c: "cat" },
      { t: now, r: 4000, f: 4000, h: "claude-code", k: "sh", c: "cat" }
    ]);
    const gain = await readGain(file);
    expect(gain.byCommand?.[0]).toMatchObject({ cmd: "cat", compressedCount: 1, count: 3, reducedPct: 90, avgPct: 30 });
  });
});
