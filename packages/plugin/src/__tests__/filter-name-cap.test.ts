import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

type FilterBody = { transform?: string; max_lines?: number };

const load = (rel: string): Record<string, FilterBody> =>
  (parseToml(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as {
    filters: Record<string, FilterBody>;
  }).filters;

describe("enumeration filters never drop names via a low max_lines", () => {
  it("find/ls sit above their smart transform's internal 1000-line cap", () => {
    const find = load("../../filters/find.toml").find;
    expect(find.transform).toBe("smart-find");
    expect(find.max_lines ?? Infinity).toBeGreaterThanOrEqual(1000);

    const ls = load("../../filters/ls.toml").ls;
    expect(ls.transform).toBe("smart-ls");
    expect(ls.max_lines ?? Infinity).toBeGreaterThanOrEqual(1000);
  });

  it("tree/tar/unzip cap runaway high, not at a name-dropping low value", () => {
    const ux = load("../../filters/unix-extra.toml");
    for (const slug of ["tree", "tar", "unzip"]) {
      expect(ux[slug].max_lines ?? Infinity, slug).toBeGreaterThanOrEqual(1000);
    }
  });

  it("system enumeration filters (ps/df/du/stat/lsof/jar) cap high, not low", () => {
    const checks: [string, string][] = [
      ["ps.toml", "ps"],
      ["df-du.toml", "df"],
      ["df-du.toml", "du"],
      ["network-shell.toml", "stat"],
      ["network-shell.toml", "lsof"],
      ["lang-package-mgr.toml", "jar"]
    ];
    for (const [file, slug] of checks) {
      expect(load(`../../filters/${file}`)[slug].max_lines ?? Infinity, slug).toBeGreaterThanOrEqual(1000);
    }
  });
});
