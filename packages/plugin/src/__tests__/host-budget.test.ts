import { describe, expect, it } from "vitest";
import { claudeCodePersistChars, PREVIEW_BUDGET_CHARS, previewExcerpt } from "../exec/host-budget";

describe("claudeCodePersistChars", () => {
  it("reads BASH_MAX_OUTPUT_LENGTH and falls back to 30 000", () => {
    expect(claudeCodePersistChars({})).toBe(30_000);
    expect(claudeCodePersistChars({ BASH_MAX_OUTPUT_LENGTH: "200000" })).toBe(200_000);
    expect(claudeCodePersistChars({ BASH_MAX_OUTPUT_LENGTH: "abc" })).toBe(30_000);
    expect(claudeCodePersistChars({ BASH_MAX_OUTPUT_LENGTH: "0" })).toBe(30_000);
    expect(claudeCodePersistChars({ BASH_MAX_OUTPUT_LENGTH: "-5" })).toBe(30_000);
  });
});

describe("previewExcerpt", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `[out#0/mp4 @ 0x77] sq: send 0 ts ${i}.000000 with some padding text`);
  lines[1000] = "Error while decoding stream #0:0: Invalid data found";
  lines[1500] = "[mp4 @ 0x1] Warning: non-monotonic DTS";
  lines[1999] = "frame=  300 fps=0.0 q=-1.0 Lsize=     253kB time=00:00:09.93 speed=12.1x";
  const text = lines.join("\n") + "\n";

  it("stays within the budget and keeps the last, failure, warning and first lines in order", () => {
    const out = previewExcerpt(text);
    expect(out.length).toBeLessThanOrEqual(PREVIEW_BUDGET_CHARS);
    const kept = out.trimEnd().split("\n");
    expect(kept[0]).toBe(lines[0]);
    expect(kept.at(-1)).toBe(lines[1999]);
    expect(kept).toContain(lines[1000]);
    expect(kept).toContain(lines[1500]);
    expect(kept.indexOf(lines[1000]!)).toBeLessThan(kept.indexOf(lines[1500]!));
    expect(out).toMatch(/^… \(\d+ more lines omitted\)$/m);
  });

  it("counts every omitted line exactly once", () => {
    const kept = previewExcerpt(text).trimEnd().split("\n");
    const omitted = kept.reduce((n, l) => n + Number(/^… \((\d+) more lines omitted\)$/.exec(l)?.[1] ?? 0), 0);
    const shown = kept.filter((l) => !/^… \(\d+ more lines omitted\)$/.test(l)).length;
    expect(shown + omitted).toBe(lines.length);
  });

  it("cuts a very long line instead of spending the whole budget on it", () => {
    const out = previewExcerpt(`${"x".repeat(50_000)}\nlast line\n`);
    expect(out.length).toBeLessThanOrEqual(PREVIEW_BUDGET_CHARS);
    expect(out).toContain("last line");
    expect(out).toContain("…");
  });

  it("gives a single very long line most of the budget, start and end", () => {
    const json = `{"items":[${Array.from({ length: 2000 }, (_, i) => `{"id":${i}}`).join(",")}],"next":"cursor-final"}`;
    const out = previewExcerpt(`${json}\n`);
    expect(out.length).toBeLessThanOrEqual(PREVIEW_BUDGET_CHARS);
    expect(out.length).toBeGreaterThan(1_500);
    expect(out.startsWith('{"items":[{"id":0}')).toBe(true);
    expect(out).toContain('"next":"cursor-final"}');
  });

  it("returns a short text whole", () => {
    expect(previewExcerpt("a\nb\n")).toBe("a\nb\n");
  });

  it("counts the lines behind an omission marker it drops", () => {
    const head = Array.from({ length: 60 }, (_, i) => `first part line ${i} with some filler text to use the budget`);
    const tail = Array.from({ length: 60 }, (_, i) => `second part line ${i} with some filler text to use the budget`);
    const out = previewExcerpt([...head, "… (785 more lines omitted)", ...tail].join("\n") + "\n");
    const lines = out.trimEnd().split("\n");
    const omitted = lines.reduce((n, l) => n + Number(/^… \((\d+) more lines omitted\)$/.exec(l)?.[1] ?? 0), 0);
    const shown = lines.filter((l) => !/^… \(\d+ more lines omitted\)$/.test(l)).length;
    expect(out).not.toContain("… (785 more lines omitted)");
    expect(shown + omitted).toBe(120 + 785);
  });

  it("never cuts a long line in the middle of a character", () => {
    const out = previewExcerpt(`${"é😀漢".repeat(2000)}\nend\n`);
    expect(out).not.toContain("\ufffd");
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
  });
});
