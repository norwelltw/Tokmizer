import { describe, expect, it } from "vitest";
import { getTransform } from "../engine/transforms/registry";
import "../engine/transforms/smart-read";

const smartRead = getTransform("smart-read")!;

function run(src: string): string[] {
  return smartRead(src.split("\n"));
}

describe("smart-read", () => {
  it("keeps imports verbatim", () => {
    const out = run(
      [
        'import { a } from "x";',
        'import { b } from "y";',
        'import { c } from "z";',
        "",
        "export function foo(): void {",
        "  doStuff();",
        "}"
      ].join("\n")
    );
    expect(out.slice(0, 3)).toEqual([
      'import { a } from "x";',
      'import { b } from "y";',
      'import { c } from "z";'
    ]);
    expect(out.join("\n")).not.toContain("imports");
  });

  it("keeps declaration signatures, folds bodies inline to `{ … }`", () => {
    const out = run(
      [
        'import { x } from "x";',
        'import { y } from "y";',
        "export async function POST(req: Request): Promise<Response> {",
        "  const a = 1;",
        "  const b = 2;",
        "  return new Response();",
        "}"
      ].join("\n")
    ).join("\n");
    expect(out).toContain('import { x } from "x";');
    expect(out).toContain("export async function POST(req: Request): Promise<Response> {");
    expect(out).toContain("lines folded");
    expect(out).not.toContain("//");
    expect(out).not.toContain("const a = 1");
  });

  it("leaves non-code text essentially intact (no imports, no decls)", () => {
    const text = ["just some prose", "another line", "and one more"].join("\n");
    expect(run(text).join("\n")).toBe(text);
  });

  it("folds class method bodies, keeps the signature", () => {
    const out = run(
      [
        "class Service {",
        "  async handle(req: Request): Promise<void> {",
        "    const a = 1;",
        "    work(a);",
        "  }",
        "  helper(x) {",
        "    return x + 1;",
        "  }",
        "}"
      ].join("\n")
    ).join("\n");
    expect(out).toContain("async handle(req: Request): Promise<void> {");
    expect(out).toContain("helper(x) {");
    expect(out).toContain("folded");
    expect(out).not.toContain("const a = 1");
  });

  it("folds control-flow block bodies, keeps the head line", () => {
    const out = run(
      [
        "if (cond) {",
        "  a();",
        "  b();",
        "}",
        "for (let i = 0; i < n; i++) {",
        "  c();",
        "}",
        "switch (k) {",
        "  case 1:",
        "    d();",
        "}"
      ].join("\n")
    ).join("\n");
    expect(out).toContain("if (cond) {");
    expect(out).toContain("for (let i = 0; i < n; i++) {");
    expect(out).toContain("switch (k) {");
    expect(out).toContain("folded");
    expect(out).not.toContain("a();");
  });

  it("does not fold callback-style calls (describe/it)", () => {
    const out = run(
      [
        'describe("suite", function() {',
        '  it("works", () => {',
        "    expect(1).toBe(1);",
        "  });",
        "});"
      ].join("\n")
    ).join("\n");
    expect(out).toContain("expect(1).toBe(1)");
    expect(out).not.toContain("folded");
  });
});
