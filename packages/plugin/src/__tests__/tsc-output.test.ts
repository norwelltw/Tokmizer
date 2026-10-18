import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { processOutput, setFilterResolver } from "../engine";
import { FilterDef } from "../engine/schema";

const source = parseToml(readFileSync(fileURLToPath(new URL("../../filters/tsc.toml", import.meta.url)), "utf8")) as {
  filters: { tsc: Record<string, unknown> };
};
const def = FilterDef.parse({ slug: "tsc", ...source.filters.tsc });
const filter = { ...def, matchRegex: new RegExp(def.match_command) };
const compiler = fileURLToPath(new URL("../../../../node_modules/typescript/bin/tsc", import.meta.url));
const captures = new Map<string, string>();
const modes = ["--listFiles", "--listFilesOnly", "--listEmittedFiles", "--showConfig"];
let fixture: string;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "tkr-tsc-output-"));
  const files = Array.from({ length: 310 }, (_, i) => `file${i}.ts`);
  for (const [i, file] of files.entries()) writeFileSync(join(fixture, file), `export const value${i} = ${i};\n`);
  writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "es5", lib: ["es5"], types: [], outDir: "dist" },
    files
  }));
  for (const mode of modes) {
    const args = [compiler, "--project", fixture, mode, ...(mode === "--listFiles" ? ["--noEmit"] : [])];
    const child = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.split("\n").length).toBeGreaterThan(300);
    captures.set(mode, child.stdout);
  }
}, 20_000);

beforeEach(() => {
  setFilterResolver(async () => filter);
});

afterEach(() => {
  setFilterResolver(null);
});

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe.each(["normal", "compact", "minimal"] as const)("tsc explicit output at %s verbosity", (verbosity) => {
  it.each(modes)("preserves every line of real %s output", async (mode) => {
    const input = captures.get(mode)!;
    const result = await processOutput(`tsc --project ${fixture} ${mode}`, input, null, { verbosity, exitCode: 0 });
    expect(result.output === input).toBe(true);
    if (mode === "--showConfig") {
      expect(JSON.parse(result.output).files).toHaveLength(310);
    }
  });

  it("preserves the existing compiler file-list capture", async () => {
    const input = readFileSync(fileURLToPath(new URL("./fixtures/audit/tsc.txt", import.meta.url)), "utf8");
    const result = await processOutput("tsc --listFiles", input, null, { verbosity, exitCode: 0 });
    expect(result.output === input).toBe(true);
  });
});

it("keeps ordinary compiler diagnostics while removing watch noise", async () => {
  const input = "Starting compilation in watch mode\nsrc/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n";
  const result = await processOutput("tsc --watch", input, null, { verbosity: "minimal", exitCode: 0 });
  expect(result.output).toBe("src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n");
});
