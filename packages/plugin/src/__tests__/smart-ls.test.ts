import { describe, expect, it, vi } from "vitest";
import { smartLs } from "../engine/transforms/smart-ls";
import { processOutput } from "../engine";
import { __resetCache } from "../engine/loader";

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


const LS_LA_SAMPLE = [
  "total 144",
  "drwxr-xr-x  12 tester  staff    384 28 mai   11:42 .",
  "drwxr-xr-x@ 26 tester  staff    832 29 mai   16:58 ..",
  "-rw-r--r--   1 tester  staff  16394 28 mai   09:48 Cargo.lock",
  "-rw-r--r--   1 tester  staff   1312 28 mai   05:34 Cargo.toml",
  "-rw-r--r--   1 tester  staff    928 28 mai   05:31 README.md",
  "drwxr-xr-x   8 tester  staff    256 28 mai   05:34 src",
  "drwxr-xr-x   3 tester  staff     96 28 mai   05:32 target"
].join("\n");

describe("smartLs", () => {
  const out = smartLs(LS_LA_SAMPLE.split("\n"));
  const text = out.join("\n");

  it("drops the `total N` header", () => {
    expect(text).not.toMatch(/total\s+144/);
  });

  it("drops the `.` and `..` entries", () => {
    expect(out).not.toContain(".");
    expect(out).not.toContain("..");
    expect(out.some((l) => /(^|\s)\.\.?(\/|\s|$)/.test(l.trim()))).toBe(false);
  });

  it("humanizes sizes (16394 → 16.0K, 1312 → 1.3K, 928 → 928)", () => {
    expect(text).toMatch(/16\.0K/);
    expect(text).toMatch(/1\.3K/);
    expect(text).toMatch(/(^|\s)928(\s|$)/m);
    expect(text).not.toMatch(/16394/);
    expect(text).not.toMatch(/\b1312\b/);
  });

  it("marks directories with a trailing slash and omits their size", () => {
    expect(out).toContain("src/");
    expect(out).toContain("target/");
    expect(out[out.length - 1]).toContain("mode dirs drwxr-xr-x");
  });

  it("orders directories before files", () => {
    const firstFileIdx = out.findIndex((l) => l.startsWith("Cargo.lock "));
    const lastDirIdx = Math.max(out.indexOf("src/"), out.indexOf("target/"));
    expect(firstFileIdx).toBeGreaterThanOrEqual(0);
    expect(lastDirIdx).toBeLessThan(firstFileIdx);
  });

  it("appends a `N files, M dirs` summary line", () => {
    expect(out[out.length - 1]).toMatch(/^\d+ files?, \d+ dirs?/);
    expect(out[out.length - 1]).toContain("3 files");
    expect(out[out.length - 1]).toContain("2 dirs");
    expect(out[out.length - 1]).toMatch(/, owner tester:staff, mode dirs drwxr-xr-x, files -rw-r--r-- unless shown$/);
  });

  it("keeps every entry's name, marker, size, mode and owner recoverable", () => {
    expectLsFidelity(LS_LA_SAMPLE, text);
  });

  it("notes a dominant extension when one leads", () => {
    const sample = [
      "total 8",
      "-rw-r--r-- 1 a b 100 28 mai 09:00 a.rs",
      "-rw-r--r-- 1 a b 200 28 mai 09:00 b.rs",
      "-rw-r--r-- 1 a b 300 28 mai 09:00 c.rs",
      "-rw-r--r-- 1 a b 400 28 mai 09:00 d.txt"
    ];
    const r = smartLs(sample).join("\n");
    expect(r).toMatch(/\(3 \.rs\)/);
  });

  it("is a strong reduction on a real-shaped listing", () => {
    const before = LS_LA_SAMPLE.length;
    const after = text.length;
    expect(after).toBeLessThan(before);
  });
});

describe("smartLs passthrough", () => {
  it("returns plain `ls` (bare names) unchanged", () => {
    const plain = ["Cargo.toml", "src", "README.md", "target"];
    expect(smartLs(plain)).toEqual(plain);
  });

  it("returns non-ls text unchanged", () => {
    const text = [
      "error[E0382]: borrow of moved value: `x`",
      "  --> src/main.rs:4:20",
      "   |",
      "4  |     let y = x;",
      "compilation failed"
    ];
    expect(smartLs(text)).toEqual(text);
  });
});

describe("smartLs long-format fidelity", () => {
  it("keeps human-readable sizes from ls -lh as printed", () => {
    const sample = [
      "-rw-r--r--@  1 tester  wheel   694B Oct 15 10:23 brew.ts",
      "-rw-r--r--@  1 tester  wheel    22K Oct 15 10:23 stats.ts",
      "-rw-r--r--   1 tester  wheel   1.2K Oct 15 10:23 bundle.ts"
    ];
    const out = smartLs(sample);
    expect(out.slice(0, 3)).toEqual(["stats.ts  22K", "-rw-r--r-- bundle.ts  1.2K", "brew.ts  694B"]);
    expect(out[3]).toBe("3 files, 0 dirs (3 .ts), owner tester:wheel, mode files -rw-r--r--@ unless shown");
    expectLsFidelity(sample.join("\n"), out.join("\n"));
  });

  it("keeps the mode on lines that differ from the common one (executable, symlink)", () => {
    const sample = [
      "-rw-r--r--@  1 tester  staff  1200 Oct 15 10:23 a.ts",
      "-rw-r--r--@  1 tester  staff  2200 Oct 15 10:23 b.ts",
      "-rw-r--r--@  1 tester  staff   300 Oct 15 10:23 c.ts",
      "-rwxr-xr-x@  1 tester  staff  1300 Oct 15 10:23 run.sh",
      "lrwxr-xr-x   1 tester  staff    11 Oct 15 10:23 current -> releases/3"
    ];
    const out = smartLs(sample);
    expect(out).toContain("-rwxr-xr-x@ run.sh  1.3K");
    expect(out).toContain("lrwxr-xr-x current -> releases/3  11");
    expect(out).toContain("b.ts  2.1K");
    expect(out.filter((l) => /^[-dl][rwxsStT-]{9}/.test(l))).toHaveLength(2);
    expect(out[out.length - 1]).toBe("5 files, 0 dirs (3 .ts), owner tester:staff, mode files -rw-r--r--@ unless shown");
    expectLsFidelity(sample.join("\n"), out.join("\n"));
  });

  it("keeps modes on every line and adds no mode suffix when there is no common mode (one file, one dir)", () => {
    const sample = [
      "drwxr-xr-x  3 tester  staff    96 Oct 15 10:23 src",
      "-rw-r--r--  1 tester  staff  1200 Oct 15 10:23 a.ts"
    ];
    const out = smartLs(sample);
    expect(out).toEqual(["drwxr-xr-x src/", "-rw-r--r-- a.ts  1.2K", "1 file, 1 dir, owner tester:staff"]);
    expect(out.join("\n")).not.toMatch(/unless shown|mode (dirs|files)/);
    expectLsFidelity(sample.join("\n"), out.join("\n"));
  });

  it("parses GNU long-iso and full-time date columns without eating the name", () => {
    const sample = [
      "drwxr-xr-x 2 root root 4096 2026-10-15 10:23 bin",
      "-rw-r--r-- 1 root root  512 2026-10-15 10:23:41.123456789 +0200 15 notes.txt"
    ];
    const out = smartLs(sample);
    expect(out[0]).toBe("drwxr-xr-x bin/");
    expect(out[1]).toBe("-rw-r--r-- 15 notes.txt  512");
    expect(out[2]).toBe("1 file, 1 dir, owner root:root");
  });

  it("keeps symlinks with their target", () => {
    const sample = ["lrwxr-xr-x  1 tester  wheel  11 Oct 15 10:23 current -> releases/3"];
    expect(smartLs(sample)[0]).toBe("lrwxr-xr-x current -> releases/3  11");
  });

  it("returns the listing unchanged when an entry cannot be parsed (device files)", () => {
    const sample = [
      "crw-rw-rw-  1 root  wheel    3,   2 Oct 15 10:23 null",
      "-rw-r--r--  1 root  wheel     512 Oct 15 10:23 a.txt"
    ];
    expect(smartLs(sample)).toEqual(sample);
  });

  it("returns the listing unchanged when it contains lines that are not entries", () => {
    const sample = [
      "ls: cannot access 'missing': No such file or directory",
      "-rw-r--r--  1 root  wheel     512 Oct 15 10:23 a.txt"
    ];
    expect(smartLs(sample)).toEqual(sample);
  });
});

describe("long listings keep permissions and ownership", () => {
  const listing = [
    "total 1024",
    "drwxr-xr-x   4 tester  staff    128 Oct 18 10:00 .",
    "drwxr-xr-x  30 tester  staff    960 Oct 18 10:00 ..",
    "-rwsrwxrwx   1 root    wheel   8400 Oct 18 10:00 backdoor",
    "-rw-rw-rw-   1 tester  staff    512 Oct 18 10:00 shared.env",
    "drwx------   2 tester  staff     64 Oct 18 10:00 private",
    ...Array.from({ length: 110 }, (_, i) => `-rw-r--r--   1 tester  staff  ${1000 + i} Oct 18 10:00 file-${String(i).padStart(3, "0")}.txt`),
    ""
  ].join("\n");

  it.each(["normal", "compact", "minimal"] as const)("shows the mode and owner of every entry from ls -la at %s", async (verbosity) => {
    vi.stubEnv("TOKMIZER_DEV", "1");
    __resetCache();
    try {
      const result = await processOutput("ls -la", listing, null, { verbosity, exitCode: 0 });
      expect(result.filterId).toBe("ls-long");
      const lines = result.output.split("\n");
      expect(lines).toContain("-rwsrwxrwx root wheel backdoor  8.2K");
      expect(lines).toContain("-rw-rw-rw- tester staff shared.env  512");
      expect(lines).toContain("drwx------ tester staff private/");
      expect(lines).toContain("tester staff file-109.txt  1.1K");
      expect(lines.filter((l) => l !== "").pop()).toMatch(/mode files -rw-r--r-- unless shown$/);
      expectLsFidelity(listing, result.output);
      expect(result.filteredBytes).toBeLessThan(result.rawBytes);
    } finally {
      vi.unstubAllEnvs();
      __resetCache();
    }
  });
});

describe("smartLs on a plain listing", () => {
  const names = [
    ...Array.from({ length: 14 }, (_, i) => `case${i}.test.ts`),
    "index.ts", "loader.ts", "pipeline.ts", "README.md", "fixtures", "my notes.txt"
  ];

  function expand(lines: string[]): string[] {
    const out: string[] = [];
    let ext = "";
    for (const line of lines.slice(1)) {
      let rest: string;
      if (line.startsWith("  ")) rest = line.slice(2);
      else {
        const m = /^(?:\*(\S+)|other) \(\d+\):(?: (.*))?$/.exec(line)!;
        ext = m[1] ?? "";
        rest = m[2] ?? "";
      }
      for (const p of rest.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []) out.push(p.startsWith('"') ? JSON.parse(p) : `${p}${ext}`);
    }
    return out;
  }

  it("groups names by extension without losing any", () => {
    const out = smartLs(names);
    expect(out[0]).toBe(`${names.length} entries:`);
    expect(out.join("\n").length).toBeLessThan(names.join("\n").length);
    expect(new Set(expand(out))).toEqual(new Set(names));
  });

  it("keeps every name of a long listing through the ls filter line cap", async () => {
    const many = Array.from({ length: 230 }, (_, i) => `module-number-${i}.test.ts`).concat(["notes.md", "data"]);
    const result = await processOutput("ls src/__tests__", many.join("\n"), null, { exitCode: 0 });
    const lines = result.output.split("\n");
    expect(lines.every((l) => l.length <= 200)).toBe(true);
    expect(new Set(expand(lines))).toEqual(new Set(many));
    expect(result.output.length).toBeLessThan(many.join("\n").length);
  });

  it("leaves a short listing untouched", () => {
    const short = names.slice(0, 11);
    expect(smartLs(short)).toEqual(short);
  });

  it("leaves a column layout untouched", () => {
    const columns = Array.from({ length: 14 }, (_, i) => `a${i}.ts    b${i}.ts    c${i}.ts`);
    expect(smartLs(columns)).toEqual(columns);
  });

  it("leaves ls -R sections untouched", () => {
    const recursive = ["src:", ...names, "", "src/fixtures:", "x.txt"];
    expect(smartLs(recursive)).toEqual(recursive);
  });
});
