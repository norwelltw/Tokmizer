import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSpool, droppedEventsCount, resetDroppedEvents } from "../learn/spool";
import { readGain, recordStat, renderGain } from "../stats";

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-leftovers-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
});

function fillSpool(name: "learn" | "telemetry"): void {
  mkdirSync(join(dir, "spool"), { recursive: true });
  appendFileSync(join(dir, "spool", `${name}.jsonl`), "x".repeat(512 * 1024));
}

describe("gain explicit scopes", () => {
  it("exposes allCommands and shortenedOnly next to the legacy fields", async () => {
    const file = join(dir, "stats.jsonl");
    recordStat(40_000, 4_000, file, false, "claude", undefined, "cat", undefined, { s: "b" });
    recordStat(4_000, 4_000, file, false, "claude", undefined, "head", undefined, { o: "g" });
    const agg = await readGain(file);
    expect(agg.allCommands).toEqual({ count: 2, rawTokens: 11_000, savedTokens: 9_000, savedPct: 81.82 });
    expect(agg.shortenedOnly?.count).toBe(1);
    expect(agg.shortenedOnly?.savedPct).toBe(90);
    expect(agg.shortenedOnly?.savedTokens).toBe(9_000);
    expect(agg.observed?.savedPct).toBe(agg.allCommands?.savedPct);
    expect(agg.shortened?.savedPct).toBe(agg.shortenedOnly?.savedPct);
  });

  it("labels both figures in the human output", async () => {
    const file = join(dir, "stats.jsonl");
    recordStat(40_000, 4_000, file, false, "claude", undefined, "cat", undefined, { s: "b" });
    recordStat(40_000, 40_000, file, false, "claude", undefined, "head", undefined, { o: "g" });
    const out = renderGain(await readGain(file), { color: false, pricePerMtok: 3 });
    expect(out).toContain("% of all commands)");
    expect(out).toContain("the 1 output Tokmizer shortened, not the overall rate");
  });
});

describe("spool dropped events", () => {
  it("counts events refused when the queue is full and keeps the file bounded", () => {
    fillSpool("telemetry");
    const before = statSync(join(dir, "spool", "telemetry.jsonl")).size;
    expect(droppedEventsCount()).toBe(0);
    appendSpool("telemetry", { cmd: "ls" });
    appendSpool("telemetry", { cmd: "ls" });
    expect(droppedEventsCount()).toBe(2);
    expect(statSync(join(dir, "spool", "telemetry.jsonl")).size).toBe(before);
    fillSpool("learn");
    appendSpool("learn", { cmd: "ls" });
    expect(droppedEventsCount()).toBe(3);
    resetDroppedEvents();
    expect(droppedEventsCount()).toBe(0);
    expect(existsSync(join(dir, "spool", "learn.dropped"))).toBe(false);
  });

  it("surfaces the count in gain data and output", async () => {
    fillSpool("telemetry");
    appendSpool("telemetry", { cmd: "ls" });
    const file = join(dir, "stats.jsonl");
    recordStat(40_000, 4_000, file, false, "claude", undefined, "cat", undefined, { s: "b" });
    const agg = await readGain(file);
    expect(agg.droppedEvents).toBe(1);
    expect(renderGain(agg, { color: false, pricePerMtok: 3 })).toContain("1 usage event was not uploaded because the queue was full.");
  });
});
