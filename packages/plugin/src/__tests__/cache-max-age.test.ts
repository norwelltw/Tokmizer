import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFresh, readSkill, writeSkill } from "../cache";
import { skillFile } from "../paths";

let dir: string;
const prevHome = process.env.TOKMIZER_HOME;
const prevMaxAge = process.env.TOKMIZER_MAX_BUNDLE_AGE_MS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-cachemaxage-"));
  process.env.TOKMIZER_HOME = dir;
  process.env.TOKMIZER_MAX_BUNDLE_AGE_MS = "1000";
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = prevHome;
  if (prevMaxAge === undefined) delete process.env.TOKMIZER_MAX_BUNDLE_AGE_MS;
  else process.env.TOKMIZER_MAX_BUNDLE_AGE_MS = prevMaxAge;
  rmSync(dir, { recursive: true, force: true });
});

describe("skill cache hard max-age", () => {
  it("serves a freshly written skill", async () => {
    await writeSkill("power", "BODY");
    expect(await isFresh("power")).toBe(true);
    expect(await readSkill("power")).toBe("BODY");
  });

  it("treats a skill older than max age as stale and unreadable", async () => {
    await writeSkill("power", "BODY");
    const old = (Date.now() - 5000) / 1000;
    utimesSync(skillFile("power"), old, old);
    expect(await isFresh("power")).toBe(false);
    expect(await readSkill("power")).toBeNull();
  });

  it("clamps TOKMIZER_MAX_BUNDLE_AGE_MS to the 7-day default so the freshness window cannot be widened forever", async () => {
    process.env.TOKMIZER_MAX_BUNDLE_AGE_MS = String(99_999_999_999);
    await writeSkill("reducer-max", "PAID");
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(skillFile("reducer-max"), eightDaysAgo, eightDaysAgo);
    expect(await readSkill("reducer-max")).toBeNull();
    expect(await isFresh("reducer-max")).toBe(false);
  });
});
