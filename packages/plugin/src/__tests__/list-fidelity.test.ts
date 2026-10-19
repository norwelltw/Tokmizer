import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadFilters, processOutput, selectFilter, setFilterResolver } from "../engine";
import { __resetCache } from "../engine/loader";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const GIT_STATUS = fixture("list/git-status.txt");
const FIND = fixture("list/find.txt");
const LS_LA = fixture("list/ls-la.txt");
const TSC_LIST = fixture("audit/tsc.txt");
const VERBOSITIES = ["normal", "compact", "minimal"] as const;
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

let origDev: string | undefined;

beforeEach(() => {
  origDev = process.env.TOKMIZER_DEV;
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
  setFilterResolver(async (cmd, allowed) => selectFilter(cmd, (await loadFilters()).values(), allowed));
});

afterEach(() => {
  setFilterResolver(null);
  if (origDev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = origDev;
  __resetCache();
});

describe.each(VERBOSITIES)("git status keeps every file at %s verbosity", (verbosity) => {
  const entries = GIT_STATUS.split("\n").filter((l) => l.startsWith("\t")).map((l) => l.trim());
  const paths = entries.map((e) => e.replace(/^(?:modified|deleted|new file):\s+/, ""));

  it("lists all 286 modified, deleted and untracked paths", async () => {
    expect(paths).toHaveLength(286);
    const r = await processOutput("git status", GIT_STATUS, null, { verbosity, exitCode: 0 });
    expect(r.filterId).toBe("git-status");
    for (const path of paths) expect(r.output).toContain(path);
    expect(r.output).not.toMatch(/more lines omitted/);
  });

  it("uses porcelain status codes per entry", async () => {
    const r = await processOutput("git status", GIT_STATUS, null, { verbosity, exitCode: 0 });
    const lines = r.output.split("\n");
    expect(lines.filter((l) => /^ M \S/.test(l))).toHaveLength(171);
    expect(lines.filter((l) => /^ D \S/.test(l))).toHaveLength(13);
    expect(lines.filter((l) => /^\?\? \S/.test(l))).toHaveLength(102);
    expect(r.output).not.toMatch(/modified:|deleted:/);
    expect(bytes(r.output)).toBeLessThanOrEqual(bytes(GIT_STATUS) * 0.88);
  });

  it("still drops the hint boilerplate and blank lines", async () => {
    const r = await processOutput("git status", GIT_STATUS, null, { verbosity, exitCode: 0 });
    expect(r.output).not.toContain('(use "git');
    expect(r.output).not.toMatch(/\n\s*\n/);
    expect(r.output.split("\n")[0]).toBe("* feat/auto-update...origin/feat/auto-update");
    expect(r.output).not.toMatch(/^(?:On branch|Your branch|Changes not staged|Untracked files)/m);
  });
});

describe.each(VERBOSITIES)("find groups flat by directory at %s verbosity", (verbosity) => {
  const names = FIND.split("\n").filter((l) => l.trim() !== "").map((l) => l.slice(l.lastIndexOf("/") + 1));

  it("keeps all 229 file names in a flat, counted grouping", async () => {
    expect(names).toHaveLength(229);
    const r = await processOutput('find packages/plugin/src -name "*.ts"', FIND, null, { verbosity, exitCode: 0 });
    expect(r.filterId).toBe("find");
    const lines = r.output.split("\n").filter((l) => l !== "");
    expect(lines[0]).toBe("229F 11D in packages/plugin/src/:");
    const rebuilt: string[] = [];
    for (const line of lines.slice(1)) {
      const m = /^(\.\/|[^\s/]+(?:\/[^\s/]+)*\/) \((\d+)(?:, \*(\.\S+))?\): (\S.*)$/.exec(line);
      expect(m, line).not.toBeNull();
      const stems = m![4]!.split(" ");
      expect(stems).toHaveLength(Number(m![2]));
      const dir = m![1] === "./" ? "" : m![1]!;
      for (const stem of stems) rebuilt.push(`packages/plugin/src/${dir}${stem}${m![3] ?? ""}`);
    }
    expect(rebuilt.sort()).toEqual(FIND.split("\n").filter((l) => l.trim() !== "").sort());
    expect(lines.some((l) => l.startsWith("__tests__/ (133, *.test.ts): "))).toBe(true);
    expect(lines.some((l) => l.startsWith("engine/transforms/ (16, *.ts): "))).toBe(true);
  });

  it("goes below the bare file names by factoring shared extensions", async () => {
    const r = await processOutput('find packages/plugin/src -name "*.ts"', FIND, null, { verbosity, exitCode: 0 });
    expect(bytes(r.output)).toBeLessThanOrEqual(bytes(names.join(" ")) * 0.8);
    expect(bytes(r.output)).toBeLessThanOrEqual(bytes(FIND) * 0.32);
  });
});

describe.each(VERBOSITIES)("ls -la drops column noise at %s verbosity", (verbosity) => {
  const names = LS_LA.split("\n")
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 9 && p[8] !== "." && p[8] !== "..")
    .map((p) => p[8]!);

  it("keeps every entry name, marks directories and keeps sizes", async () => {
    expect(names).toHaveLength(43);
    const r = await processOutput("ls -la packages/plugin/src", LS_LA, null, { verbosity, exitCode: 0 });
    expect(r.filterId).toBe("ls-long");
    for (const name of names) expect(r.output).toContain(name);
    expect(r.output).toMatch(/^drwxr-xr-x@ __tests__\/$/m);
    expect(r.output).toMatch(/^-rw-r--r--@ brew\.ts  694$/m);
    expect(r.output).toMatch(/^-rw-r--r--@ stats\.ts  22\.9K$/m);
    expect(r.output).toMatch(/^34 files, 9 dirs \(34 \.ts\), owner tester:wheel$/m);
  });

  it("keeps every mode, states the shared owner once, drops dates and halves the output", async () => {
    const r = await processOutput("ls -la packages/plugin/src", LS_LA, null, { verbosity, exitCode: 0 });
    const entries = r.output.split("\n").filter((l) => /^[-dl]/.test(l));
    expect(entries).toHaveLength(43);
    for (const line of entries) expect(line).toMatch(/^[-dl][rwxsStT-]{9}@ \S/);
    expect(r.output).not.toMatch(/tester wheel|Oct 15|^total/m);
    expect(bytes(r.output)).toBeLessThanOrEqual(bytes(LS_LA) * 0.5);
  });
});

describe.each(VERBOSITIES)("tsc file listing without diagnostics at %s verbosity", (verbosity) => {
  it("collapses an implicit file listing to a one-line count", async () => {
    const r = await processOutput("tsc --noEmit", TSC_LIST, null, { verbosity, exitCode: 0 });
    expect(r.filterId).toBe("tsc");
    expect(r.output).toBe("tsc: 0 errors, 1163 files\n");
  });

  it("keeps an explicitly requested listing verbatim", async () => {
    const r = await processOutput("tsc --noEmit --listFiles", TSC_LIST, null, { verbosity, exitCode: 0 });
    expect(r.output).toBe(TSC_LIST);
  });

  it("keeps every error line verbatim when diagnostics are present", async () => {
    const errors = [
      "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(7,3): error TS2304: Cannot find name 'foo'."
    ];
    const input = `${TSC_LIST}${errors.join("\n")}\n`;
    const failing = await processOutput("tsc --noEmit", input, null, { verbosity, exitCode: 2 });
    expect(failing.output).toBe(input);
    const zeroExit = await processOutput("tsc --noEmit", input, null, { verbosity, exitCode: 0 });
    for (const line of errors) expect(zeroExit.output).toContain(line);
    expect(zeroExit.output).not.toMatch(/^tsc: 0 errors/m);
  });
});
