import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processOutput, setFilterResolver, READ_FOLD_MIN_BYTES } from "../engine";
import { __resetCache } from "../engine/loader";

const code = [
  "export function invoiceTotal(subtotal: number, discount: number, taxRate: number) {",
  "  if (subtotal < 0 || discount < 0 || taxRate < 0) {",
  '    throw new Error("Amounts and rates must be non-negative");',
  "  }",
  "  const discounted = subtotal - discount;",
  "  const taxable = Math.max(0, discounted);",
  "  const tax = taxable * taxRate;",
  "  const gross = taxable + tax;",
  "  const cents = Math.round(gross * 100);",
  "  return cents / 100;",
  "}",
  ""
].join("\n");

beforeEach(() => {
  vi.stubEnv("TOKMIZER_DEV", "1");
  __resetCache();
  setFilterResolver(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetCache();
  setFilterResolver(null);
});

describe.each(["normal", "compact", "minimal"] as const)("targeted reads in %s", (verbosity) => {
  it.each(["cat invoice.ts", "bash-tool: cat invoice.ts", "read-tool: invoice.ts", "cd src && /bin/cat invoice.ts"])("keeps validation and calculation verbatim through %s", async (command) => {
    const result = await processOutput(command, code, null, { verbosity, exitCode: 0 });
    expect(result.output).toBe(code);
    expect(result.filteredBytes).toBe(Buffer.byteLength(code));
    expect(result.droppedTail).toBeNull();
  });

  it("preserves repeated statements, whitespace and line positions in a short native read", async () => {
    const input = "let x = 0;\n" + "x++;\n".repeat(80) + "\n\nexport { x };\n";
    const result = await processOutput("read-tool: counter.ts", input, null, { verbosity, exitCode: 0 });
    expect(result.output).toBe(input);
  });

  it.each(["sed -n '1,330p' invoice.ts", "sed -E -n '1,330p' invoice.ts", "sed -En '1,330p' invoice.ts", "sed -ne '1,330p' invoice.ts", "head -n 330 invoice.ts", "cat invoice.ts | tail -n 330"])("preserves the explicit slice from %s beyond automatic caps", async (command) => {
    const input = code.repeat(30);
    const result = await processOutput(command, input, null, { verbosity, exitCode: 0 });
    expect(result.output).toBe(input);
  });
});

it("keeps YOLO destructive for the same short function", async () => {
  const result = await processOutput("cat invoice.ts", code, null, { yolo: true, exitCode: 0 });
  expect(result.output).not.toContain("Math.round(gross * 100)");
  expect(result.filteredBytes).toBeLessThan(result.rawBytes);
  expect(result.droppedTail).toBeNull();
});

it("retains outlining for a broad code dump", async () => {
  const result = await processOutput("cat invoice.ts", code.repeat(60), null, { verbosity: "minimal", exitCode: 0 });
  expect(result.filteredBytes).toBeLessThan(result.rawBytes / 2);
  expect(result.output).toContain("invoiceTotal");
});

const helper = [
  "export function roundCents(amount: number) {",
  "  const cents = Math.round(amount * 100);",
  "  return cents / 100;",
  "}",
  ""
].join("\n");

it.each(["compact", "minimal"] as const)("keeps very short function bodies in a large read at %s", async (verbosity) => {
  const input = (helper + code).repeat(60);
  const result = await processOutput("cat invoice.ts", input, null, { verbosity, exitCode: 0 });
  expect(result.output).toContain("const cents = Math.round(amount * 100);");
  expect(result.filteredBytes).toBeLessThan(result.rawBytes / 2);
});

it.each(["cat invoice.ts", "read-tool: invoice.ts"])("keeps a read up to 16 KiB complete in Light through %s", async (command) => {
  const input = code.repeat(30);
  const result = await processOutput(command, input, null, { verbosity: "normal", exitCode: 0 });
  expect(result.output).toBe(input);
  expect(result.droppedTail).toBeNull();
});

it("compresses a read above 16 KiB in Light through cat", async () => {
  const input = code.repeat(60);
  const result = await processOutput("cat invoice.ts", input, null, { verbosity: "normal", exitCode: 0 });
  expect(result.filteredBytes).toBeLessThan(result.rawBytes);
});

it.each(["normal", "compact", "minimal"] as const)("keeps a native Read under the fold threshold complete at %s", async (verbosity) => {
  for (const repeat of [12, 60]) {
    const input = code.repeat(repeat);
    expect(Buffer.byteLength(input)).toBeLessThan(READ_FOLD_MIN_BYTES);
    const result = await processOutput("read-tool: invoice.ts", input, null, { verbosity, exitCode: 0 });
    expect(result.output).toBe(input);
    expect(result.droppedTail).toBeNull();
  }
});

it.each(["normal", "compact", "minimal"] as const)("compresses a native Read above the fold threshold at %s", async (verbosity) => {
  const input = code.repeat(Math.ceil(READ_FOLD_MIN_BYTES / Buffer.byteLength(code)) + 1);
  const result = await processOutput("read-tool: invoice.ts", input, null, { verbosity, exitCode: 0 });
  expect(result.filteredBytes).toBeLessThan(result.rawBytes);
  expect(result.output).toMatch(/lines folded \(\d+-\d+\): Read offset=\d+ limit=\d+ before editing …/);
});

it("keeps explicit outlining available in Light", async () => {
  const input = code.repeat(60);
  const result = await processOutput("cat invoice.ts", input, null, { verbosity: "normal", smartCode: true, exitCode: 0 });
  expect(result.output).toContain("lines folded");
  expect(result.output).not.toContain("Math.round(gross * 100)");
});

it("does not reinterpret an ambiguous command sequence as a targeted read", async () => {
  const input = "INFO setting up dependencies\n".repeat(200) + code;
  const result = await processOutput("npm install; head -n 20 invoice.ts", input, null, { verbosity: "minimal", exitCode: 0 });
  expect(result.filteredBytes).toBeLessThan(result.rawBytes);
});

it("retains compression for a broad inventory piped through head", async () => {
  const input = Array.from({ length: 3000 }, (_, index) => `/workspace/node_modules/dependency-${index}/lib/index.js`).join("\n");
  const result = await processOutput("find /workspace -type f | head -3000", input, null, { verbosity: "minimal", exitCode: 0 });
  expect(result.filteredBytes).toBeLessThan(result.rawBytes / 2);
  expect(result.output).toContain("omitted");
});
