import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyFilter } from "../engine/pipeline";
import { FilterDef } from "../engine/schema";
import { loadFilters, __resetCache } from "../engine/loader";
import { smartCodeCollapse } from "../engine/transforms/smart-code";
import { dedupeAdjacent, collapseBlankRuns, dropVerboseLogs } from "../engine/transforms/prompt-compress";

const prevDev = process.env.TOKMIZER_DEV;

beforeAll(() => {
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
});

afterAll(() => {
  if (prevDev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = prevDev;
  __resetCache();
});

const TEN_MB = 10 * 1024 * 1024;

function synth(line: string, sizeBytes: number): string {
  const lineSize = Buffer.byteLength(line + "\n", "utf8");
  const count = Math.ceil(sizeBytes / lineSize);
  return Array.from({ length: count }, () => line).join("\n");
}

describe("10MB+ bench", () => {
  it("10MB through git filter under 500ms", async () => {
    const filters = await loadFilters();
    const git = filters.get("git");
    expect(git).toBeDefined();
    const input = synth("[33mcommit abc[0m hello world ".repeat(4), TEN_MB);
    const t0 = performance.now();
    const out = applyFilter(input, git!);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(500);
    expect(out.length).toBeGreaterThan(0);
  });

  it("10MB no-op filter under 1200ms", () => {
    const def = FilterDef.parse({ slug: "n", match_command: "^n", priority: 1 });
    const input = synth("x", TEN_MB);
    const t0 = performance.now();
    applyFilter(input, def);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(1200);
  });

  it("dedupeAdjacent on 1M-line input under 800ms", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1_000_000; i++) lines.push(i % 3 === 0 ? "a" : "b");
    const t0 = performance.now();
    const out = dedupeAdjacent(lines);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(800);
    expect(out.length).toBeLessThan(lines.length);
  });

  it("collapseBlankRuns on 1M-line input under 500ms", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1_000_000; i++) lines.push(i % 5 === 0 ? "x" : "");
    const t0 = performance.now();
    const out = collapseBlankRuns(lines);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(500);
    expect(out.length).toBeLessThan(lines.length);
  });

  it("dropVerboseLogs on 500k-line input under 600ms", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500_000; i++) lines.push(i % 4 === 0 ? "DEBUG x" : "real");
    const t0 = performance.now();
    const out = dropVerboseLogs(lines);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(600);
    expect(out.length).toBeLessThanOrEqual(lines.length);
    expect(out.some((l) => l.includes("dropped"))).toBe(true);
  });

  it("smartCodeCollapse on 50k-line code input under 400ms", () => {
    const block = [
      "function foo() {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  const d = 4;",
      "  const e = 5;",
      "  return a + b + c + d + e;",
      "}"
    ];
    const lines: string[] = [];
    for (let i = 0; i < 6250; i++) lines.push(...block);
    const t0 = performance.now();
    const out = smartCodeCollapse(lines);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(400);
    expect(out.length).toBe(lines.length);
    expect(out.join("\n").length).toBeLessThan(lines.join("\n").length);
  });

  it("memory stays bounded — 10MB filter does not RSS-grow > 200MB", async () => {
    const filters = await loadFilters();
    const git = filters.get("git");
    expect(git).toBeDefined();
    const baseRss = process.memoryUsage().rss;
    const input = synth("[33mcommit abc[0m hello world ", TEN_MB);
    applyFilter(input, git!);
    const deltaMb = (process.memoryUsage().rss - baseRss) / (1024 * 1024);
    expect(deltaMb).toBeLessThan(200);
  });
});
