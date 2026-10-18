import { describe, expect, it } from "vitest";
import { selectFilter } from "../engine/matcher";
import type { LoadedFilter } from "../engine/loader";
import { slugKey } from "../contracts";

function filter(slug: string): LoadedFilter {
  return { slug, match_command: ".*", matchRegex: /.*/, priority: 1, strip_ansi: false };
}

describe("filter collection isolation", () => {
  it("keeps old and replacement runtimes independent across interleaved requests", () => {
    const old = [filter("old")];
    const replacement = [filter("new")];
    expect(selectFilter("echo", old, null)?.slug).toBe("old");
    expect(selectFilter("echo", replacement, null)?.slug).toBe("new");
    expect(selectFilter("echo", old, null)?.slug).toBe("old");
    expect(selectFilter("echo", replacement, null)?.slug).toBe("new");
  });

  it("applies changes to an allowed set on the next request", () => {
    const filters = [filter("git-log")];
    const allowed = new Set([slugKey("git-log")]);
    expect(selectFilter("git log", filters, allowed)?.slug).toBe("git-log");
    allowed.clear();
    expect(selectFilter("git log", filters, allowed)).toBeNull();
    allowed.add(slugKey("git-log"));
    expect(selectFilter("git log", filters, allowed)?.slug).toBe("git-log");
  });
});
