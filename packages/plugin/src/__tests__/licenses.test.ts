import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, "utf8");

describe("licence layout", () => {
  it("keeps the engine and rule catalogue licences identical to the root copy", () => {
    expect(read("src/engine/LICENSE")).toBe(read("LICENSE-ENGINE"));
    expect(read("filters/LICENSE")).toBe(read("LICENSE-ENGINE"));
    expect(read("LICENSE-ENGINE")).toContain("src/engine/ and\n                      filters/ directories");
    expect(read("LICENSE-ENGINE")).toMatch(/^Business Source License 1\.1/);
    expect(read("LICENSE")).toMatch(/Apache License\s+Version 2\.0/);
  });

  it("declares both licences and ships every notice file", () => {
    const pkg = JSON.parse(read("package.json")) as { license: string; files: string[] };
    expect(pkg.license).toBe("Apache-2.0 AND BUSL-1.1");
    for (const file of ["LICENSE-ENGINE", "LICENSES.md", "NOTICE", "THIRD-PARTY-NOTICES.md"]) {
      expect(pkg.files).toContain(file);
      expect(existsSync(`${root}${file}`)).toBe(true);
    }
  });
});

describe("secret scanner", () => {
  it("catches planted secrets and personal home paths, not public keys or generic homes", async () => {
    const scan = (await import("../../scripts/secret-scan.mjs")) as {
      selfTest(): boolean;
      scanText(text: string, label: string, markers?: string[]): string[];
    };
    expect(scan.selfTest()).toBe(true);
    expect(scan.scanText("cd /Users/dev/project && ls /home/runner/work", "x")).toEqual([]);
    expect(scan.scanText(["", "Users", "jdoe", "secret"].join("/"), "x")).toEqual(["x: home directory path"]);
    expect(scan.scanText("host internal.example", "x", ["internal.example"])).toEqual(["x: private marker #1"]);
  });
});
