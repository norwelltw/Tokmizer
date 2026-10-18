import { describe, expect, it, vi } from "vitest";
import { smartLs } from "../engine/transforms/smart-ls";
import { processOutput } from "../engine";
import { __resetCache } from "../engine/loader";

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
    expect(out).toContain("drwxr-xr-x src/");
    expect(out).toContain("drwxr-xr-x target/");
  });

  it("orders directories before files", () => {
    const firstFileIdx = out.findIndex((l) => l.includes(" Cargo.lock "));
    const lastDirIdx = Math.max(
      out.indexOf("drwxr-xr-x src/"),
      out.indexOf("drwxr-xr-x target/")
    );
    expect(firstFileIdx).toBeGreaterThanOrEqual(0);
    expect(lastDirIdx).toBeLessThan(firstFileIdx);
  });

  it("appends a `N files, M dirs` summary line", () => {
    expect(out[out.length - 1]).toMatch(/^\d+ files?, \d+ dirs?/);
    expect(out[out.length - 1]).toContain("3 files");
    expect(out[out.length - 1]).toContain("2 dirs");
    expect(out[out.length - 1]).toMatch(/, owner tester:staff$/);
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
    expect(out[0]).toBe("-rw-r--r--@ stats.ts  22K");
    expect(out[1]).toBe("-rw-r--r-- bundle.ts  1.2K");
    expect(out[2]).toBe("-rw-r--r--@ brew.ts  694B");
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
      expect(lines).toContain("-rw-r--r-- tester staff file-109.txt  1.1K");
      expect(result.filteredBytes).toBeLessThan(result.rawBytes);
    } finally {
      vi.unstubAllEnvs();
      __resetCache();
    }
  });
});
