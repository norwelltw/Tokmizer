import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadFilters, processOutput, selectFilter, setFilterResolver } from "../engine";
import { __resetCache } from "../engine/loader";
import { smartGrep } from "../engine/transforms/smart-grep";
import { smartFind } from "../engine/transforms/smart-find";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

type LsRow = { name: string; isDir: boolean; size: string | null; mode: string; owner: string | null };
const LS_MODE = String.raw`[-dlbcps][rwxsStT-]{9}[@.+]?`;

/** Recover every entry (mode, owner, name, dir marker, size) from smart-ls output, filling in the summary's shared mode/owner. */
function decodeLs(output: string): { rows: LsRow[]; summary: string } {
  const lines = output.split("\n").filter((l) => l !== "");
  const summary = lines[lines.length - 1]!;
  const sharedOwner = /, owner ([^\s,]+:[^\s,]+)/.exec(summary)?.[1]?.replace(":", " ") ?? null;
  const dirMode = new RegExp(`, mode (?:dirs (${LS_MODE}))?`).exec(summary)?.[1] ?? null;
  const fileMode = new RegExp(`, mode (?:dirs ${LS_MODE}, )?files (${LS_MODE}) unless shown$`).exec(summary)?.[1] ?? null;
  const rows = lines.slice(0, -1).map((line): LsRow => {
    const m = new RegExp(`^(${LS_MODE}) `).exec(line);
    let rest = m ? line.slice(m[1]!.length + 1) : line;
    let owner = sharedOwner;
    if (!sharedOwner) {
      const o = /^(\S+) (\S+) /.exec(rest)!;
      owner = `${o[1]} ${o[2]}`;
      rest = rest.slice(o[0].length);
    }
    const isDir = rest.endsWith("/") && !/  \S+$/.test(rest);
    if (isDir) return { name: rest.slice(0, -1), isDir, size: null, mode: m?.[1] ?? dirMode ?? "?", owner };
    const cut = rest.lastIndexOf("  ");
    return { name: rest.slice(0, cut), isDir, size: rest.slice(cut + 2), mode: m?.[1] ?? fileMode ?? "?", owner };
  });
  return { rows, summary };
}

/** Parse a raw `ls -l` listing (skipping total, . and ..); sizes are humanized like smart-ls does for plain byte counts. */
function parseRawLs(raw: string): LsRow[] {
  const human = (n: number): string => {
    if (n < 1024) return String(n);
    let v = n / 1024;
    let u = 0;
    while (v >= 1024 && u < 3) { v /= 1024; u += 1; }
    return `${v.toFixed(1)}${"KMGT"[u]}`;
  };
  return raw.split("\n").flatMap((line) => {
    const m = new RegExp(`^(${LS_MODE})\\s+\\d+\\s+(\\S+)\\s+(\\S+)\\s+(\\d+|[\\d.]+[KMGT]?B?)\\s+(?:\\S+\\s+\\S+\\s+\\S+)\\s+(.+)$`).exec(line);
    if (!m || m[5] === "." || m[5] === "..") return [];
    const isDir = m[1]![0] === "d";
    return [{ name: m[5]!, isDir, size: isDir ? null : /^\d+$/.test(m[4]!) ? human(Number(m[4])) : m[4]!, mode: m[1]!, owner: `${m[2]} ${m[3]}` }];
  });
}

/** Fidelity contract: every raw entry is recoverable from the output (same set, name, dir marker, size, mode, owner). */
function expectLsFidelity(raw: string, output: string): void {
  const key = (r: LsRow): string => `${r.name}\u0000${r.isDir}`;
  const byKey = (rows: LsRow[]): LsRow[] => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  expect(byKey(decodeLs(output).rows)).toEqual(byKey(parseRawLs(raw)));
}

const NEXT = fixture("audit/next.txt");
const GCLOUD = fixture("audit/gcloud.txt");
const TERRAFORM = fixture("audit/terraform.txt");
const CARGO = fixture("audit/cargo.txt");
const LS_LA = fixture("list/ls-la.txt");

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

describe("next build", () => {
  it("reduces a clean build to its success line", async () => {
    const r = await processOutput("next build", NEXT, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output.trim()).toBe("✓ Compiled successfully in 26.88s");
    expect(bytes(r.output)).toBeLessThanOrEqual(53);
  });

  it("keeps warnings with their locations and drops dev recompiles", async () => {
    const input = [
      " ✓ Compiled /dashboard in 412ms",
      " ⚠ Compiled with warnings",
      "./src/app/page.tsx",
      "12:5  Warning: Unexpected any. Specify a different type.  @typescript-eslint/no-explicit-any",
      "+ First Load JS shared by all                        102 kB",
      " ✓ Compiled successfully in 3.1s"
    ].join("\n");
    const r = await processOutput("next build", input, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).not.toContain("/dashboard in 412ms");
    expect(r.output).not.toContain("First Load JS");
    expect(r.output).toContain("⚠ Compiled with warnings");
    expect(r.output).toContain("./src/app/page.tsx");
    expect(r.output).toContain("12:5  Warning: Unexpected any.");
    expect(r.output).toContain("✓ Compiled successfully in 3.1s");
  });
});

describe("cargo build", () => {
  it("drops lockfile upgrade notices and keeps warnings with locations", async () => {
    const r = await processOutput("cargo build", CARGO, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).not.toMatch(/\(available: v/);
    expect(r.output).toContain("Finished `dev` profile [unoptimized + debuginfo] target(s) in 17.33s");
    expect(bytes(r.output)).toBeLessThanOrEqual(103);
    const warned = await processOutput("cargo build", [
      "      Adding serde v1.0.1 (available: v1.0.2)",
      "warning: unused variable: `x`",
      " --> src/main.rs:3:9",
      "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.4s"
    ].join("\n"), null, { verbosity: "compact", exitCode: 0 });
    expect(warned.output).toContain("warning: unused variable: `x`");
    expect(warned.output).toContain(" --> src/main.rs:3:9");
    expect(warned.output).not.toContain("Adding serde");
  });
});

describe("ls -la", () => {
  it("separates name and size without alignment padding", async () => {
    const r = await processOutput("ls -la packages/plugin/src", LS_LA, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).toContain("\nstats.ts  22.9K\n");
    expectLsFidelity(LS_LA, r.output);
    expect(r.output).not.toMatch(/\S {3,}\S/);
    expect(bytes(r.output)).toBeLessThan(1300);
  });
});

describe("git status branch and sections", () => {
  const status = (head: string[]): string => [
    ...head,
    "",
    "Changes to be committed:",
    '  (use "git restore --staged <file>..." to unstage)',
    "\tnew file:   src/new.ts",
    "",
    "Changes not staged for commit:",
    "\tmodified:   src/a.ts",
    "",
    "Untracked files:",
    "\tnotes.md",
    ""
  ].join("\n");

  it.each([
    [["On branch main", "Your branch is up to date with 'origin/main'."], "* main...origin/main"],
    [["On branch main", "Your branch is ahead of 'origin/main' by 2 commits."], "* main...origin/main [ahead 2]"],
    [["On branch main", "Your branch is behind 'origin/main' by 1 commit, and can be fast-forwarded."], "* main...origin/main [behind 1]"],
    [["On branch topic"], "* topic"]
  ])("encodes %j as %s and keeps every entry with its state code", async (head, expected) => {
    const r = await processOutput("git status", status(head), null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).toBe(`${expected}\nA  src/new.ts\n M src/a.ts\n?? notes.md\n`);
  });

  it("leaves a diverged branch message intact", async () => {
    const r = await processOutput("git status", status([
      "On branch main",
      "Your branch and 'origin/main' have diverged,",
      "and have 1 and 2 different commits each, respectively."
    ]), null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).toContain("* main\nYour branch and 'origin/main' have diverged,\nand have 1 and 2 different commits each, respectively.\n");
  });
});

describe("gcloud tables", () => {
  const header = GCLOUD.split("\n").find((l) => l.startsWith("NAME "))!;
  const starts = [...header.matchAll(/\S+/g)].map((m) => m.index!);
  const rawRows = new Set(GCLOUD.split("\n").filter((l) => /^instance-/.test(l))
    .map((l) => starts.map((s, i) => l.slice(s, starts[i + 1] ?? l.length).trim()).join("\t")));

  it("keeps each shown row cell for cell, empty cells included, and every distinct warning once", async () => {
    const r = await processOutput("gcloud compute instances list", GCLOUD, null, { verbosity: "compact", exitCode: 0 });
    const lines = r.output.split("\n").filter((l) => l !== "");
    expect(lines.filter((l) => l === "WARNING: This command is using service account impersonation")).toHaveLength(1);
    expect(lines).toContain("WARNING: The following projects do not have a compute API enabled (skipped):");
    expect(lines).toContain("NAME\tZONE\tMACHINE_TYPE\tPREEMPTIBLE\tINTERNAL_IP\tEXTERNAL_IP\tSTATUS");
    const rows = lines.filter((l) => l.startsWith("instance-"));
    expect(rows.length).toBeGreaterThanOrEqual(25);
    for (const row of rows) {
      expect(row.split("\t")).toHaveLength(7);
      expect(rawRows.has(row)).toBe(true);
    }
    expect(r.output).toMatch(/^… \(\d+ more lines omitted\)$/m);
    expect(bytes(r.output)).toBeLessThanOrEqual(3291);
  });

  it("falls back to the aligned text when a row does not fit the header columns", async () => {
    const input = ["NAME   ZONE", "a      z1", "much-longer-name-overflowing z2"].join("\n");
    const r = await processOutput("gcloud compute instances list", input, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).toBe(input);
    const wide = ["NAME   ZONE", "名前   z1", "b      z2"].join("\n");
    const w = await processOutput("gcloud compute instances list", wide, null, { verbosity: "compact", exitCode: 0 });
    expect(w.output).toBe(wide);
  });
});

describe("terraform plan", () => {
  it("drops attribute alignment padding and keeps every attribute and value", async () => {
    const input = [
      '  # aws_instance.web will be updated in-place',
      '  ~ resource "aws_instance" "web" {',
      '      ~ instance_type                = "t3.micro" -> "t3.large"',
      '        id                           = "i-0abc"',
      '      + "tag with spaces"            = "x    y"',
      "    }",
      "Plan: 0 to add, 1 to change, 0 to destroy."
    ].join("\n");
    const r = await processOutput("terraform plan", input, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).toContain('      ~ instance_type = "t3.micro" -> "t3.large"');
    expect(r.output).toContain('        id = "i-0abc"');
    expect(r.output).toContain('      + "tag with spaces" = "x    y"');
    expect(r.output).toContain("Plan: 0 to add, 1 to change, 0 to destroy.");
    const fixture = await processOutput("terraform plan", TERRAFORM, null, { verbosity: "compact", exitCode: 0 });
    expect(fixture.output).not.toMatch(/\w {2,}= /);
  });
});

describe("git show --stat", () => {
  const show = [
    "commit f16036e2b30be9220e36c15ec687ac98714d6ac9",
    "Author: A <a@example.com>",
    "",
    "    Subject",
    "",
    " packages/plugin/README.md                       |  6 +++---",
    " .../plugin/src/__tests__/gain-measurement.test.ts | 21 ++++++++++++++++++++-",
    " assets/logo.png                                 | Bin 0 -> 1234 bytes",
    " 3 files changed, 23 insertions(+), 4 deletions(-)"
  ].join("\n");

  it("drops stat column padding and keeps file, count and bar", async () => {
    const r = await processOutput("git show --stat HEAD", show, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).toContain(" packages/plugin/README.md | 6 +++---\n");
    expect(r.output).toContain(" .../plugin/src/__tests__/gain-measurement.test.ts | 21 ++++++++++++++++++++-\n");
    expect(r.output).toContain(" assets/logo.png | Bin 0 -> 1234 bytes\n");
    expect(r.output).toContain(" 3 files changed, 23 insertions(+), 4 deletions(-)");
    expect(r.output).toContain("commit f16036e2b30be9220e36c15ec687ac98714d6ac9");
  });

  it("does not touch diff body lines that only look like stat rows", async () => {
    const diff = ["diff --git a/t.md b/t.md", "@@ -1,2 +1,2 @@", " a    | 3 ++", "-old", "+new"].join("\n");
    const r = await processOutput("git diff", diff, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).toContain(" a    | 3 ++");
  });
});

describe("grep grouping factors the shared directory", () => {
  it("prints the common directory once and keeps every file path recoverable", () => {
    const input = [
      "/Users/me/repo/src/engine/a.ts:1:import x",
      "/Users/me/repo/src/engine/a.ts:4:import y",
      "/Users/me/repo/src/engine/transforms/b.ts:2:import z"
    ];
    const out = smartGrep(input);
    expect(out[0]).toBe("3m 2f in /Users/me/repo/src/engine/:");
    expect(out).toContain("a.ts (2):");
    expect(out).toContain("transforms/b.ts (1):");
    expect(out).toContain("  1: import x");
    expect(out).toContain("  2: import z");
  });

  it("keeps full paths when files share no directory", () => {
    const out = smartGrep(["a.ts:1:x", "a.ts:2:y", "lib/b.ts:1:z"]);
    expect(out[0]).toBe("3m 2f:");
    expect(out).toContain("lib/b.ts (1):");
  });
});

describe("find factors a shared extension per directory", () => {
  it("factors only the dotted suffix every name shares", () => {
    expect(smartFind(["src/x.d.ts", "src/y.ts", "src/z.test.ts"])).toEqual(["3F 1D in src/:", "./ (3, *.ts): x.d y z.test"]);
  });

  it("leaves names alone without a shared extension, with quoted names or a bare extension", () => {
    expect(smartFind(["a/Makefile", "a/x.ts"])[1]).toBe("./ (2): Makefile x.ts");
    expect(smartFind(["a/my file.ts", "a/x.ts", "a/y.ts"])[1]).toBe('./ (3): "my file.ts" x.ts y.ts');
    expect(smartFind(["a/.ts", "a/x.ts"])[1]).toBe("./ (2): .ts x.ts");
  });
});
