import { describe, expect, it } from "vitest";
import { smartCodeCollapse, looksLikeCode } from "../engine/transforms/smart-code";

describe("looksLikeCode", () => {
  it("false on prose", () => {
    const text = "hello world\nthis is a long line of english text that has no code\nfoo\nbar\nbaz\nqux";
    expect(looksLikeCode(text)).toBe(false);
  });

  it("true on TS source", () => {
    const text = [
      "import { foo } from 'x';",
      "export function bar() {",
      "  return foo();",
      "}",
      "const baz = 1;",
      "// done"
    ].join("\n");
    expect(looksLikeCode(text)).toBe(true);
  });

  it("false on very short input even if code-like", () => {
    expect(looksLikeCode("function x() {}")).toBe(false);
  });
});

describe("smartCodeCollapse", () => {
  it("passes through non-code lines unchanged", () => {
    const lines = ["a", "b", "c"];
    expect(smartCodeCollapse(lines)).toEqual(lines);
  });

  it("folds a Rust fn with lifetimes cleanly (no body leak)", () => {
    const lines = [
      "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {",
      "    if x.len() > y.len() {",
      "        x",
      "    } else {",
      "        y",
      "    }",
      "}"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe(lines[0]);
    expect(out[out.length - 1]).toBe("}");
    expect(out.join("\n")).not.toContain("x.len()");
    expect(out[1]).toMatch(/lines folded/);
  });

  it("keeps a generic impl header intact and folds inner fns without corruption", () => {
    const lines = [
      "impl<'a, T> Parser<'a, T> {",
      "    fn parse(&self) -> T {",
      "        self.inner.parse()",
      "    }",
      "}"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe("impl<'a, T> Parser<'a, T> {");
    expect(out[1]).toBe("    fn parse(&self) -> T {");
    expect(out[2]).toMatch(/line folded/);
    expect(out.join("\n")).not.toContain("self.inner.parse()");
    expect(out[out.length - 1]).toBe("}");
  });

  it("still ignores braces inside single-quoted strings", () => {
    const lines = [
      "function f() {",
      "  const open = '{';",
      "  const close = '}';",
      "  return open + close;",
      "}"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe("function f() {");
    expect(out.join("\n")).not.toContain("const open");
    expect(out[1]).toMatch(/lines folded/);
  });

  it("treats an unclosed apostrophe as plain text, not a string opener", () => {
    const lines = [
      "function g() {",
      "  step(); // user's data",
      "  done();",
      "}"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe("function g() {");
    expect(out.join("\n")).not.toContain("step()");
  });

  it("folds a function body inline to `{ … }`", () => {
    const lines = [
      "function foo() {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  const d = 4;",
      "  const e = 5;",
      "  return a + b + c + d + e;",
      "}"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe("function foo() {");
    expect(out[1]).toMatch(/6 lines folded/);
    expect(out.join("\n")).not.toContain("const a = 1");
  });

  it("folds short functions to `{ … }` too (consistency)", () => {
    const lines = ["function f() {", "  return 1;", "}"];
    const out = smartCodeCollapse(lines);
    expect(out).toEqual(["function f() {", "  … 1 line folded …", "}"]);
  });

  it("emits no `//` comment lines and no closing brace line", () => {
    const lines = [
      "export async function POST(req: NextRequest): Promise<NextResponse> {",
      "  const a = 1;",
      "  doStuff();",
      "  return new Response();",
      "}"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe("export async function POST(req: NextRequest): Promise<NextResponse> {");
    expect(out.join("\n")).not.toContain("doStuff");
    expect(out.join("\n")).not.toContain("//");
    expect(out.join("\n")).not.toContain("more lines");
  });

  it("keeps the class and method signatures, folds multi-line method bodies", () => {
    const lines = [
      "class Foo {",
      "  short() { return 1; }",
      "  long(x: number): number {",
      "    const a = x + 1;",
      "    const b = a * 2;",
      "    return b;",
      "  }",
      "}"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe("class Foo {");
    expect(out[1]).toBe("  short() { return 1; }");
    expect(out[2]).toBe("  long(x: number): number {");
    expect(out[3]).toMatch(/lines folded/);
    expect(out.join("\n")).not.toContain("const a = x + 1");
    expect(out[out.length - 1]).toBe("}");
  });

  it("keeps surrounding non-declaration lines", () => {
    const lines = [
      "const x = 1;",
      "function foo() {",
      "  return x;",
      "}",
      "const y = 2;"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe("const x = 1;");
    expect(out[1]).toBe("function foo() {");
    expect(out[2]).toMatch(/1 line folded/);
    expect(out[3]).toBe("}");
    expect(out[4]).toBe("const y = 2;");
  });

  it("does NOT swallow a body with an unbalanced brace in a string literal", () => {
    const lines = [
      "function bad() {",
      "  const s = \"{\";",
      "  return s;"
    ];
    const out = smartCodeCollapse(lines);
    expect(out).toEqual(lines);
  });

  it("does NOT swallow when the body never closes (EOF, depth > 0)", () => {
    const lines = [
      "function open() {",
      "  doStuff();",
      "  more();"
    ];
    const out = smartCodeCollapse(lines);
    expect(out).toEqual(lines);
  });

  it("does NOT fold past the max window of 200 lines", () => {
    const body = Array.from({ length: 250 }, (_, k) => `  line${k}();`);
    const lines = ["function huge() {", ...body, "}"];
    const out = smartCodeCollapse(lines);
    expect(out).toEqual(lines);
  });

  it("recovers and still folds a well-formed body after an aborted unbalanced one", () => {
    const lines = [
      "function bad() {",
      "  const s = \"{\";",
      "function ok() {",
      "  return 1;",
      "}"
    ];
    const out = smartCodeCollapse(lines);
    expect(out.length).toBe(lines.length);
    expect(out[0]).toBe("function bad() {");
    expect(out[1]).toBe("  const s = \"{\";");
    expect(out[2]).toBe("function ok() {");
    expect(out[3]).toMatch(/1 line folded/);
    expect(out[4]).toBe("}");
  });
});
