import { describe, expect, it } from "vitest";
import { applyFilter, applyFilterWithTail } from "../engine/pipeline";
import "../engine/transforms/smart-read";
import { FilterDef } from "../engine/schema";
import "../engine/transforms/smart-find";

const base = (over: Partial<{
  slug: string;
  match_command: string;
  strip_ansi: boolean;
  strip_lines_matching: string[];
  truncate_lines_at: number;
  max_lines: number;
  on_empty: string;
  priority: number;
  transform: string;
}>) =>
  FilterDef.parse({
    slug: "x",
    match_command: "^x",
    strip_ansi: false,
    strip_lines_matching: [],
    priority: 50,
    ...over
  });

describe("applyFilter pipeline", () => {
  it("strips ansi when enabled", () => {
    const def = base({ strip_ansi: true });
    const out = applyFilter("hello[31mred[0m world", def);
    expect(out).toBe("hello[31mred[0m world".replace(/\[[0-9;]*m/g, ""));
  });

  it("drops lines matching", () => {
    const def = base({ strip_lines_matching: ["^skip"] });
    const out = applyFilter("keep\nskip me\nkeep too", def);
    expect(out).toBe("keep\nkeep too");
  });

  it("truncates wide lines", () => {
    const def = base({ truncate_lines_at: 5 });
    const out = applyFilter("abcdefghij\nshort", def);
    expect(out).toBe("abcde…\nshort");
  });

  it("caps max lines and appends omitted notice", () => {
    const def = base({ max_lines: 2 });
    const out = applyFilter("a\nb\nc\nd", def);
    expect(out).toBe("a\nb\n… (2 more lines omitted)");
  });

  it("returns on_empty if final output blank", () => {
    const def = base({ strip_lines_matching: ["^.*$"], on_empty: "nothing" });
    const out = applyFilter("erase me\nme too", def);
    expect(out).toBe("nothing");
  });

  it("does not drop find names past the 100th dir (max_lines must sit above the smart-find tree cap)", () => {
    const def = FilterDef.parse({
      slug: "find",
      match_command: "^find",
      strip_ansi: false,
      strip_lines_matching: [],
      priority: 60,
      transform: "smart-find",
      max_lines: 2000
    });
    const paths = Array.from({ length: 200 }, (_, i) => `d${String(i).padStart(3, "0")}/needle${i}.ts`);
    const out = applyFilter(paths.join("\n"), def);
    expect(out).toContain("needle199.ts");
    expect(out).not.toMatch(/more lines omitted/);
  });
});

describe("preserve_exact", () => {
  const dataInput = [
    "pending",
    "pending",
    "pending",
    "",
    "",
    "",
    "{",
    '  "status": "ok",',
    '  "status": "ok",',
    "}"
  ].join("\n");

  it("keeps data byte-identical at compact verbosity", () => {
    const def = FilterDef.parse({
      slug: "psql",
      match_command: "^psql",
      preserve_exact: true,
      max_lines: 500
    });
    expect(applyFilter(dataInput, def, { verbosity: "compact" })).toBe(dataInput);
  });

  it("keeps data byte-identical at minimal verbosity", () => {
    const def = FilterDef.parse({
      slug: "stripe",
      match_command: "^stripe",
      preserve_exact: true
    });
    const withLogs = ["INFO noise-looking data row", ...dataInput.split("\n")].join("\n");
    expect(applyFilter(withLogs, def, { verbosity: "minimal" })).toBe(withLogs);
  });

  it("still caps runaway output with an honest marker", () => {
    const def = FilterDef.parse({
      slug: "psql",
      match_command: "^psql",
      preserve_exact: true,
      max_lines: 100,
      scale_with_level: false
    });
    const rows = Array.from({ length: 300 }, (_, i) => `row-${i}`).join("\n");
    const out = applyFilter(rows, def, { verbosity: "compact" });
    expect(out).toContain("row-0");
    expect(out).toMatch(/more lines omitted/);
  });
});

describe("trailing newline", () => {
  const def = (extra: { max_lines: number }) => base(extra);

  it("does not count a trailing newline as an extra omitted line", () => {
    const input = "a\nb\nc\n";
    expect(applyFilter(input, def({ max_lines: 3 }))).toBe(input);
  });

  it("counts only real lines in the omission marker", () => {
    const out = applyFilter("a\nb\nc\nd\ne\n", def({ max_lines: 3 }));
    expect(out).toContain("(2 more lines omitted)");
  });
});

describe("head and tail truncation", () => {
  it("keeps the start and the end with the omission marker in the middle", () => {
    const input = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const out = applyFilter(input, base({ max_lines: 10 })).split("\n");
    expect(out[0]).toBe("l1");
    expect(out[out.length - 1]).toBe("l20");
    expect(out).toContain("… (10 more lines omitted)");
    expect(out.length).toBe(11);
  });

  it("puts the omitted middle in the restorable part", () => {
    const input = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const { droppedTail } = applyFilterWithTail(input, base({ max_lines: 10 }));
    expect(droppedTail).toContain("l10");
    expect(droppedTail).not.toContain("l20");
  });
});

describe("smart-read fold padding", () => {
  const code = [
    "export function a() {",
    ...Array.from({ length: 12 }, (_, i) => `  const v${i} = ${i};`),
    "}",
    "export function b() {",
    ...Array.from({ length: 12 }, (_, i) => `  const w${i} = ${i};`),
    "}"
  ].join("\n");

  it("drops padding lines outside the Read tool", () => {
    const out = applyFilter(code, base({ slug: "cat", transform: "smart-read" } as never)).split("\n");
    expect(out.filter((l) => l === "").length).toBe(0);
    expect(out.filter((l) => /lines folded/.test(l)).length).toBe(2);
  });

  it("keeps padding for the Read tool so line numbers stay right", () => {
    const out = applyFilter(code, base({ slug: "read-tool", transform: "smart-read" } as never)).split("\n");
    expect(out.length).toBe(code.split("\n").length);
  });

  it("does not count padding against the Read cap", () => {
    const out = applyFilter(code, base({ slug: "read-tool", transform: "smart-read", max_lines: 8 } as never));
    expect(out).not.toContain("more lines omitted");
  });

  it("keeps the Read tool head-only so numbering is never shifted", () => {
    const input = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const out = applyFilter(input, base({ slug: "read-tool", max_lines: 10 } as never)).split("\n");
    expect(out.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `l${i + 1}`));
    expect(out[10]).toBe("… (10 more lines omitted)");
  });
});
