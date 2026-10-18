import { describe, it, expect } from "vitest";
import { smartGrep } from "../engine/transforms/smart-grep";

describe("smartGrep", () => {
  it("groups multiple matches in one file under a single header, dropping the repeated path", () => {
    const input = [
      "src/very/long/path/module.ts:10:const a = 1;",
      "src/very/long/path/module.ts:20:const b = 2;",
      "src/very/long/path/module.ts:30:const c = 3;"
    ];
    const out = smartGrep(input);
    expect(out[0]).toBe("3m 1f:");
    expect(out).toContain("src/very/long/path/module.ts (3):");
    expect(out).toContain("  10: const a = 1;");
    expect(out.join("\n").match(/src\/very\/long\/path\/module\.ts/g)?.length).toBe(1);
  });

  it("returns input unchanged when each file has a single match (no grouping benefit)", () => {
    const input = ["a.ts:1:x", "b.ts:1:y", "c.ts:1:z"];
    expect(smartGrep(input)).toEqual(input);
  });

  it("bails on non-grep output (a line without a colon prefix)", () => {
    const input = ["src/a.ts:1:hit", "this is just prose without a match shape"];
    expect(smartGrep(input)).toEqual(input);
  });

  it("handles grep without line numbers", () => {
    const input = ["pkg/x.ts:foo()", "pkg/x.ts:bar()"];
    const out = smartGrep(input);
    expect(out[0]).toBe("2m 1f:");
    expect(out).toContain("pkg/x.ts (2):");
    expect(out).toContain("  foo()");
  });

  it.each(["C:\\src\\", "C:/src/"])("preserves numbered Windows paths under %s without guessing file boundaries", (root) => {
    const input = [
      `${root}a.ts:12:foo:13:bar`,
      `${root}b.ts:20:other()`,
      `${root}a.ts:14:baz()`
    ];
    expect(smartGrep(input)).toEqual(input);
  });

  it.each(["C:\\src\\", "C:/src/"])("preserves unnumbered Windows paths under %s without guessing file boundaries", (root) => {
    const input = [`${root}a.ts:foo:13:bar`, `${root}b.ts:other()`, `${root}a.ts:baz()`];
    expect(smartGrep(input)).toEqual(input);
  });

  it.each(["C:\\src\\", "C:/src/"])("preserves Windows grep context under %s", (root) => {
    const input = [
      `${root}my-file.ts-10-before:context`,
      `${root}my-file.ts:11:target()`,
      `${root}my-file.ts-12-after()`,
      "--",
      `${root}my-file.ts:41:target2()`
    ];
    expect(smartGrep(input)).toEqual(input);
  });

  it("preserves single-letter filenames and colons in match content", () => {
    const input = ["a:12:C:\\src\\a.ts:13:foo", "a:14:a:/src/b.ts:15:bar"];
    expect(smartGrep(input)).toEqual([
      "2m 1f:",
      "",
      "a (2):",
      "  12: C:\\src\\a.ts:13:foo",
      "  14: a:/src/b.ts:15:bar"
    ]);
  });

  it.each(["a", "A"])("preserves unnumbered matches in %s whose content resembles Windows paths", (file) => {
    const input = [`${file}:/etc/hosts:allow`, `${file}:/etc/hosts:deny`, `${file}:/etc/passwd:check`];
    expect(smartGrep(input)).toEqual(input);
  });

  it.each(["a", "A"])("preserves content in %s that resembles numbered Windows matches", (file) => {
    const input = [`${file}:/etc/hosts:1:allow`, `${file}:/etc/hosts:2:deny`, `${file}:/etc/passwd:3:check`];
    expect(smartGrep(input)).toEqual(input);
  });

  it.each(["a", "A"])("preserves content in %s that resembles Windows context", (file) => {
    const input = [`${file}:/etc/hosts-1-allow`, `${file}:/etc/hosts-2-deny`, `${file}:/etc/passwd-3-check`];
    expect(smartGrep(input)).toEqual(input);
  });

  it.each(["src/", "C:\\src\\", "C:/src/"])("preserves ambiguous match and context prefixes under %s", (root) => {
    const input = [
      `${root}my-file.ts-10-before:99:context`,
      `${root}my-file.ts:11:target()`,
      `${root}my-file.ts:41:target2()`
    ];
    expect(smartGrep(input)).toEqual(input);
  });

  it.each(["C:\\my repo\\a.ts", "C:/my repo/a.ts"])("preserves unsupported Windows path %s without grouping by drive", (file) => {
    const input = [`${file}:12:foo()`, `${file}:13:bar()`];
    expect(smartGrep(input)).toEqual(input);
  });

  it("truncates very long match content", () => {
    const long = "x".repeat(500);
    const input = [`f.ts:1:${long}`, `f.ts:2:short`];
    const out = smartGrep(input);
    const longLine = out.find((l) => l.includes("xxxx"));
    expect(longLine!.length).toBeLessThan(220);
    expect(longLine!.endsWith("…")).toBe(true);
  });

  it("lists source files before tests and fixtures", () => {
    const input = [
      "src/__tests__/a.test.ts:1:hit", "src/__tests__/a.test.ts:2:hit",
      "src/zeta.ts:1:hit", "src/zeta.ts:2:hit",
      "fixtures/x.txt:1:hit"
    ];
    const headers = smartGrep(input).filter((l) => /\(\d+\):$/.test(l));
    expect(headers).toEqual(["src/zeta.ts (2):", "fixtures/x.txt (1):", "src/__tests__/a.test.ts (2):"]);
  });

  it("puts a compact index of every file first when the result is long", () => {
    const input: string[] = [];
    for (let f = 0; f < 30; f += 1) for (let i = 1; i <= 4; i += 1) input.push(`src/mod${f}.ts:${i}:const v = ${i};`);
    const out = smartGrep(input);
    const indexLines = out.slice(1, out.indexOf(""));
    const index = indexLines.join(" ");
    expect(out[0]).toBe("120m 30f in src/:");
    for (let f = 0; f < 30; f += 1) expect(index).toContain(`mod${f}.ts (4)`);
    expect(indexLines.every((l) => l.length <= 190)).toBe(true);
    expect(indexLines.length).toBeLessThan(10);
  });

  it("does not add an index to a short result", () => {
    const out = smartGrep(["a.ts:1:x", "a.ts:2:y", "b.ts:1:z"]);
    expect(out[1]).toBe("");
  });

  it("groups grep context output instead of bailing", () => {
    const input = [
      "src/my-file.ts-10-  before();",
      "src/my-file.ts:11:  target();",
      "src/my-file.ts-12-  after();",
      "--",
      "src/my-file.ts-40-  before2();",
      "src/my-file.ts:41:  target();"
    ];
    const out = smartGrep(input);
    expect(out[0]).toBe("2m 1f:");
    expect(out).toContain("src/my-file.ts (2):");
    expect(out).toContain("  10- before();");
    expect(out).toContain("  11: target();");
    expect(out).toContain("  --");
  });
});
