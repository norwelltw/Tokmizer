import { afterEach, describe, expect, it } from "vitest";
import { processOutput, setFilterResolver, type LoadedFilter } from "../engine";

function filter(slug: string, strip: string): LoadedFilter {
  return { slug, match_command: ".*", matchRegex: /.*/, priority: 1, strip_ansi: false, strip_lines_matching: [strip] };
}

afterEach(() => setFilterResolver(null));

describe("request-scoped engine resolution", () => {
  it("uses the supplied resolver instead of another caller's installed resolver", async () => {
    setFilterResolver(async () => filter("global", "^keep$"));
    const result = await processOutput("echo", "keep\ndrop\n", null, {
      resolver: async () => filter("request", "^drop$")
    });
    expect(result.output).toBe("keep\n");
    expect(result.filterId).toBe("request");
  });

  it("keeps overlapping resolutions isolated when the global resolver changes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = processOutput("echo", "a\nb\n", null, {
      resolver: async () => {
        await gate;
        return filter("first", "^b$");
      }
    });
    const second = processOutput("echo", "a\nb\n", null, {
      resolver: async () => filter("second", "^a$")
    });
    setFilterResolver(async () => filter("unrelated", ".*"));
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => [result.filterId, result.output])).toEqual([
      ["first", "a\n"], ["second", "b\n"]
    ]);
  });

  it("does not fall back to a global filter when the request resolver finds none", async () => {
    setFilterResolver(async () => filter("global", ".*"));
    const result = await processOutput("echo", "unchanged\n", null, { resolver: async () => null });
    expect(result.output).toBe("unchanged\n");
    expect(result.filterId).toBeNull();
  });
});
