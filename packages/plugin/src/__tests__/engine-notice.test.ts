import { describe, expect, it } from "vitest";
import { engineNotice } from "../ui";

describe("engineNotice", () => {
  it("stays silent when the daemon serves rules", () => {
    expect(engineNotice(162, null)).toBe("");
  });

  it("warns when the daemon is up with zero rules and nothing is cached", () => {
    expect(engineNotice(0, null)).toContain("reconnecting");
    expect(engineNotice(0, 0)).toContain("reconnecting");
  });

  it("stays silent when a daemon that has not warmed up yet can load cached rules", () => {
    expect(engineNotice(0, 162)).toBe("");
  });

  it("mentions cached rules when the daemon is offline but the cache serves", () => {
    const out = engineNotice(null, 162);
    expect(out).toContain("engine offline");
    expect(out).toContain("162 cached rules");
  });

  it("points at doctor when offline with no cache", () => {
    const out = engineNotice(null, null);
    expect(out).toContain("offline");
    expect(out).toContain("tkr doctor");
  });

  it("stays silent offline when built-in rules keep compression running", () => {
    expect(engineNotice(0, null, 164)).toBe("");
    expect(engineNotice(0, 0, 164)).toBe("");
  });

  it("names built-in rules when the daemon is unreachable and nothing is cached", () => {
    const out = engineNotice(null, null, 164);
    expect(out).toContain("164 built-in rules");
    expect(out).not.toContain("reconnecting");
  });

  it("still warns when no rule source is available", () => {
    expect(engineNotice(0, null, null)).toContain("reconnecting");
    expect(engineNotice(0, null, 0)).toContain("reconnecting");
  });
});
