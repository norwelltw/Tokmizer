import { beforeAll, describe, expect, it } from "vitest";
import { applyFilter } from "../engine/pipeline";
import { FilterDef } from "../engine/schema";
import { loadFilters, __resetCache } from "../engine/loader";

beforeAll(() => {
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
});

const ONE_MB = 1024 * 1024;

function synth(line: string, sizeBytes: number): string {
  const lineSize = Buffer.byteLength(line + "\n", "utf8");
  const count = Math.ceil(sizeBytes / lineSize);
  return Array.from({ length: count }, () => line).join("\n");
}

describe("filter bench", () => {
  it("processes 1MB input through git filter under 50ms", async () => {
    const filters = await loadFilters();
    const git = filters.get("git");
    expect(git).toBeDefined();
    const input = synth("[33mcommit abc[0m hello world ".repeat(4), ONE_MB);
    const t0 = performance.now();
    applyFilter(input, git!);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(50);
  });

  it("processes 1MB input through a no-op filter under 120ms", () => {
    const def = FilterDef.parse({ slug: "n", match_command: "^n", priority: 1 });
    const input = synth("x", ONE_MB);
    const t0 = performance.now();
    applyFilter(input, def);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(120);
  });
});
