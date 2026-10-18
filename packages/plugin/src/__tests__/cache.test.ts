import { describe, expect, it } from "vitest";
import { writeSkill, readSkill, isFresh } from "../cache";

describe("skill cache", () => {
  it("write + read round-trip", async () => {
    await writeSkill("test-slug-cache", "hello");
    const v = await readSkill("test-slug-cache");
    expect(v).toBe("hello");
  });

  it("isFresh returns false for missing slug", async () => {
    const fresh = await isFresh("no-such-slug-12345-xyz");
    expect(fresh).toBe(false);
  });

  it("isFresh returns true right after write", async () => {
    await writeSkill("test-fresh-cache", "x");
    const fresh = await isFresh("test-fresh-cache");
    expect(fresh).toBe(true);
  });
});
