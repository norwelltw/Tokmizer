import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGain, readDaily, renderDaily } from "../stats";

function seed(records: object[]): string {
  const file = join(mkdtempSync(join(tmpdir(), "tkr-gain-")), "stats.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

describe("gain time windows", () => {
  it("readGain filters by sinceTs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const file = seed([
      { t: now - 10 * 86400, r: 1000, f: 100 },
      { t: now - 1 * 86400, r: 1000, f: 100 }
    ]);
    expect((await readGain(file, 0)).count).toBe(2);
    expect((await readGain(file, now - 7 * 86400)).count).toBe(1);
  });

  it("readDaily buckets by local day, ascending", async () => {
    const now = Math.floor(Date.now() / 1000);
    const file = seed([
      { t: now - 2 * 86400, r: 4000, f: 400 },
      { t: now - 2 * 86400, r: 4000, f: 400 },
      { t: now - 1 * 86400, r: 8000, f: 800 }
    ]);
    const rows = await readDaily(file, 0);
    expect(rows.length).toBe(2);
    expect(rows[0].count).toBe(2);
    expect(rows[1].count).toBe(1);
  });

  it("renderDaily shows rows + Total, empty -> empty string", async () => {
    const now = Math.floor(Date.now() / 1000);
    const file = seed([{ t: now, r: 4000, f: 400 }]);
    const table = renderDaily(await readDaily(file, 0), { color: false });
    expect(table).toContain("Total");
    expect(table).toContain("Day");
    expect(renderDaily([], { color: false })).toBe("");
  });
});
