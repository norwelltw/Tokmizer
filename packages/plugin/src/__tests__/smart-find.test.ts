import { describe, expect, it } from "vitest";
import { getTransform } from "../engine/transforms/registry";
import "../engine/transforms/smart-find";

const sf = getTransform("smart-find")!;
const run = (s: string): string[] => sf(s.split("\n"));

describe("smart-find", () => {
  it("groups paths flat by directory with per-directory counts and a header", () => {
    const out = run(["app/a.ts", "app/b.ts", "app/sub/c.ts", "top.ts"].join("\n"));
    expect(out).toEqual(["4F 3D:", "./ (1): top.ts", "app/ (2, *.ts): a b", "app/sub/ (1): c.ts"]);
  });

  it("hoists the common root into the header and lists directories relative to it", () => {
    const out = run(["packages/src/a.ts", "packages/src/x/b.ts", "packages/src/x/y/c.ts"].join("\n"));
    expect(out).toEqual([
      "3F 3D in packages/src/:",
      "./ (1): a.ts",
      "x/ (1): b.ts",
      "x/y/ (1): c.ts"
    ]);
  });

  it("never indents: every output line starts at column 0", () => {
    const out = run(["a/b/c/d/e.ts", "a/b/f.ts", "a/g.ts", "h.ts"].join("\n"));
    expect(out.every((l) => !/^\s/.test(l))).toBe(true);
  });

  it("keeps every name in a directory, no per-dir cap", () => {
    const files = Array.from({ length: 20 }, (_, i) => `d/f${i}.ts`);
    const out = run(files.join("\n"));
    const line = out.find((l) => l.startsWith("./ (20, *.ts): "))!;
    const names = line.slice("./ (20, *.ts): ".length).split(" ");
    for (let i = 0; i < 20; i += 1) expect(names).toContain(`f${i}`);
    expect(line).not.toContain("+");
  });

  it("keeps paths containing spaces, quoted", () => {
    const out = run(["app/a.ts", "app/my file.txt", "app/b.ts", "app/c.ts"].join("\n"));
    expect(out[0]).toBe("4F 1D in app/:");
    expect(out[1]).toContain('"my file.txt"');
  });

  it("keeps find: error lines verbatim after the groups", () => {
    const out = run(["app/a.ts", "app/b.ts", "app/c.ts", "find: '/root': Permission denied"].join("\n"));
    expect(out[0]).toBe("3F 1D in app/:");
    expect(out[out.length - 1]).toBe("find: '/root': Permission denied");
  });

  it("caps runaway output globally with an honest omission marker", () => {
    const files = Array.from({ length: 1500 }, (_, i) => `d${String(i).padStart(4, "0")}/f.ts`);
    const out = run(files.join("\n"));
    expect(out).toHaveLength(1001);
    expect(out[out.length - 1]).toMatch(/^… \d+ more lines omitted$/);
  });

  it("keeps find: errors visible even when the global cap truncates the groups", () => {
    const files = Array.from({ length: 1500 }, (_, i) => `d${String(i).padStart(4, "0")}/f.ts`);
    const input = [...files, "find: '/root': Permission denied"].join("\n");
    const out = run(input);
    expect(out[out.length - 1]).toBe("find: '/root': Permission denied");
    expect(out[out.length - 2]).toMatch(/^… \d+ more lines omitted$/);
  });

  it("passes through non-path output (find -exec, prose)", () => {
    const lines = ["some file content with spaces", "another line of text here", "more prose output"];
    expect(run(lines.join("\n"))).toEqual(lines);
  });

  it("returns input unchanged when empty", () => {
    expect(run("")).toEqual([""]);
  });
});
