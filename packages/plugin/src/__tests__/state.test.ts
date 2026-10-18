import { describe, expect, it, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { loadState, saveState, clearState } from "../state";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokmizer-state-"));
});

describe("plugin state", () => {
  it("defers legacy timezone lookup until needed and preserves it when serialized", async () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ token: "fixture", plan: "pro" }));
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    try {
      const state = await loadState({ dir });
      expect(state?.plan).toBe("pro");
      expect(formatter).not.toHaveBeenCalled();
      const zone = state?.timeZone;
      expect(typeof zone).toBe("string");
      expect(JSON.parse(JSON.stringify(state)).timeZone).toBe(zone);
      expect(formatter).toHaveBeenCalledTimes(1);
    } finally {
      formatter.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });

  it("returns null when no file exists", async () => {
    const s = await loadState({ dir });
    expect(s).toBeNull();
  });

  it("round-trips a state object", async () => {
    await saveState(
      {
        token: "tokmizer_abc",
        jwt: "jwt-value",
        signingSecret: "secret",
        plan: "trial",
        status: "active",
        trialEndsAt: new Date().toISOString(),
        subEndsAt: null,
        jwtVersion: 1,
        installId: "11111111-1111-1111-1111-111111111111",
        email: "u@x.com"
      },
      { dir }
    );
    const s = await loadState({ dir });
    expect(s?.token).toBe("tokmizer_abc");
    expect(s?.plan).toBe("trial");
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const base = {
      jwt: "jwt-value",
      signingSecret: "secret",
      plan: "trial" as const,
      status: "active" as const,
      trialEndsAt: null,
      subEndsAt: null,
      jwtVersion: 1,
      installId: "11111111-1111-1111-1111-111111111111",
      email: "u@x.com"
    };
    await saveState({ ...base, token: "first" }, { dir });
    await saveState({ ...base, token: "second" }, { dir });
    expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
    const s = await loadState({ dir });
    expect(s?.token).toBe("second");
  });

  it("keeps state.json parsable under concurrent writers", async () => {
    const base = {
      jwt: "jwt-value",
      signingSecret: "secret",
      plan: "trial" as const,
      status: "active" as const,
      trialEndsAt: null,
      subEndsAt: null,
      jwtVersion: 1,
      installId: "11111111-1111-1111-1111-111111111111",
      email: "u@x.com"
    };
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => saveState({ ...base, token: `t${i}` }, { dir }))
    );
    const s = await loadState({ dir });
    expect(s).not.toBeNull();
    expect(s!.token).toMatch(/^t\d+$/);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("clearState removes the file", async () => {
    await saveState(
      {
        token: "x",
        jwt: "y",
        signingSecret: "z",
        plan: "trial",
        status: "active",
        trialEndsAt: null,
        subEndsAt: null,
        jwtVersion: 1,
        installId: "11111111-1111-1111-1111-111111111111",
        email: "u@x.com"
      },
      { dir }
    );
    await clearState({ dir });
    const s = await loadState({ dir });
    expect(s).toBeNull();
    rmSync(dir, { recursive: true });
  });
});
