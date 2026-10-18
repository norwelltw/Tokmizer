import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordStat, readGain } from "../stats";

describe("readGain prices savings by the host that produced them", () => {
  let file: string;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), "tkr-stats-host-")), "stats.jsonl");
  });

  it("buckets saved tokens per provider via the recorded host", async () => {
    recordStat(400, 100, file, false, "codex");
    recordStat(400, 100, file, false, "claude-code");
    const agg = await readGain(file);
    expect(agg.savedByProvider.openai).toBe(75);
    expect(agg.savedByProvider.anthropic).toBe(75);
  });

  it("attributes host-less (historical) records to anthropic", async () => {
    recordStat(400, 100, file);
    const agg = await readGain(file);
    expect(agg.savedByProvider.anthropic).toBe(75);
    expect(agg.savedByProvider.openai ?? 0).toBe(0);
  });

  it("maps cursor savings to the anthropic rate", async () => {
    recordStat(400, 100, file, false, "cursor");
    const agg = await readGain(file);
    expect(agg.savedByProvider.anthropic).toBe(75);
  });
});
