import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

type FilterBody = { priority?: number; max_lines?: number };

const load = (rel: string): Record<string, FilterBody> =>
  (parseToml(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as {
    filters: Record<string, FilterBody>;
  }).filters;

describe("filter routing and JSON safety", () => {
  it("specific build-tool filters outrank the generic npm filter (no priority tie on `npm run X`)", () => {
    const npm = load("../../filters/npm.toml").npm.priority ?? 0;
    const next = load("../../filters/next.toml").next.priority ?? 0;
    const tsc = load("../../filters/tsc.toml").tsc.priority ?? 0;
    expect(next).toBeGreaterThan(npm);
    expect(tsc).toBeGreaterThan(npm);
  });

  it("raw-json api filters do not line-truncate (a line cap corrupts JSON)", () => {
    const ghApi = load("../../filters/vcs-platform.toml")["gh-api"];
    const glabApi = load("../../filters/glab-variants.toml")["glab-api"];
    expect(ghApi.max_lines).toBeUndefined();
    expect(glabApi.max_lines).toBeUndefined();
    expect(ghApi.priority ?? 0).toBeGreaterThan(load("../../filters/vcs-platform.toml").gh.priority ?? 0);
    expect(glabApi.priority ?? 0).toBeGreaterThan(load("../../filters/vcs-platform.toml").glab.priority ?? 0);
  });
});
