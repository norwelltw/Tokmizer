import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capJsonl } from "../jsonl-cap";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-cap-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("capJsonl", () => {
  it("leaves a file under the trigger size untouched", () => {
    const f = join(dir, "a.jsonl");
    writeFileSync(f, "x\n".repeat(10));
    capJsonl(f, 100, 50);
    expect(readFileSync(f, "utf8")).toBe("x\n".repeat(10));
  });

  it("keeps the newest whole lines within the keep size once the trigger is passed", () => {
    const f = join(dir, "b.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => `{"n":${String(i).padStart(2, "0")}}`);
    writeFileSync(f, `${lines.join("\n")}\n`);
    capJsonl(f, 200, 100);
    const kept = readFileSync(f, "utf8").trim().split("\n");
    expect(kept[kept.length - 1]).toBe('{"n":49}');
    expect(statSync(f).size).toBeLessThanOrEqual(100);
    expect(kept.every((l) => /^\{"n":\d\d\}$/.test(l))).toBe(true);
  });

  it("ignores a missing file", () => {
    expect(() => capJsonl(join(dir, "none.jsonl"), 10, 5)).not.toThrow();
  });
});
