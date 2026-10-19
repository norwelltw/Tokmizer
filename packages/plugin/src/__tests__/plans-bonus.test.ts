import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slugKey } from "../contracts";
import { resolveAllowedFilters } from "../default-rules";
import { buildDefaultRules } from "../default-rules-build";

describe("server-authoritative allowed-filter resolution", () => {
  it("returns opaque keys for the heartbeat-cached set, never raw slugs", () => {
    const cached = ["git", "ansible-playbook", "vault"];
    const got = resolveAllowedFilters(cached, false)!;
    expect(got.has(slugKey("ansible-playbook"))).toBe(true);
    expect(got.has(slugKey("vault"))).toBe(true);
    expect(got.has("ansible-playbook")).toBe(false);
    expect(got.size).toBe(3);
    for (const k of got) expect(k).toMatch(/^[0-9a-f]{16}$/);
  });

  it("accepts already-hashed cached entries unchanged", () => {
    const k = slugKey("git");
    const got = resolveAllowedFilters([k], false)!;
    expect(got.has(k)).toBe(true);
    expect(got.size).toBe(1);
  });

  describe("cold start, empty set or offline grace exceeded", () => {
    const saved = process.env.TOKMIZER_DEFAULT_RULES;
    beforeAll(async () => {
      process.env.TOKMIZER_DEFAULT_RULES = await buildDefaultRules();
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.TOKMIZER_DEFAULT_RULES;
      else process.env.TOKMIZER_DEFAULT_RULES = saved;
    });

    it("falls back to the full embedded catalogue on a cold start (no cached set)", () => {
      const got = resolveAllowedFilters(undefined, false)!;
      expect(got.has(slugKey("git"))).toBe(true);
      expect(got.has(slugKey("terraform"))).toBe(true);
      expect(got.has(slugKey("gcloud"))).toBe(true);
      expect(got.has(slugKey("ansible-playbook"))).toBe(true);
    });

    it("ignores an empty cached set and uses the full catalogue", () => {
      expect(resolveAllowedFilters([], false)).toEqual(resolveAllowedFilters(undefined, false));
    });

    it("keeps the full catalogue when offline grace is exceeded", () => {
      const got = resolveAllowedFilters(["git"], true)!;
      expect(got).toEqual(resolveAllowedFilters(undefined, false));
      expect(got.has(slugKey("vault"))).toBe(true);
    });
  });

  it("leaves the gate open when no catalogue is embedded", () => {
    const saved = process.env.TOKMIZER_DEFAULT_RULES;
    delete process.env.TOKMIZER_DEFAULT_RULES;
    try {
      expect(resolveAllowedFilters(undefined, false)).toBeNull();
      expect(resolveAllowedFilters(["git"], true)).toBeNull();
    } finally {
      if (saved !== undefined) process.env.TOKMIZER_DEFAULT_RULES = saved;
    }
  });

  it("matcher gates on opaque keys end-to-end", async () => {
    const { selectFilter } = await import("../engine/matcher");
    const f = {
      slug: "git",
      match_command: "^git\\b",
      priority: 50,
      strip_ansi: false,
      matchRegex: /^git\b/
    } as never;
    const hit = selectFilter("git log", [f] as never, resolveAllowedFilters(["git"], false));
    expect(hit).not.toBeNull();
    const miss = selectFilter("git log", [f] as never, resolveAllowedFilters(["docker"], false));
    expect(miss).toBeNull();
  });
});
