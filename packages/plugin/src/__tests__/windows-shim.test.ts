import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShim } from "../shim/runner";

describe.skipIf(process.platform !== "win32")("Windows command execution", () => {
  let dir: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tok windows "));
    previousPath = process.env.PATH;
    process.env.PATH = `${dir};${previousPath ?? ""}`;
    writeFileSync(join(dir, "args.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(join(dir, "audit-args.cmd"), `@"${process.execPath}" "%~dp0args.cjs" %*\r\n`);
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs npm.cmd through the shim", async () => {
    const result = await runShim({ cmdName: "npm", args: ["--version"] });
    expect(result.exitCode).toBe(0);
    expect(result.filteredOut.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("preserves arguments and spaces in a batch executable path", async () => {
    const args = ["two words", "plain", "quote\"inside"];
    const result = await runShim({ cmdName: "audit-args.cmd", args });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.filteredOut)).toEqual(args);
  });
});
