import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graceExceeded } from "../entitlement";
import type { State } from "../state";

let origGrace: string | undefined;

beforeEach(() => {
  origGrace = process.env.TOKMIZER_OFFLINE_GRACE_MS;
});

afterEach(() => {
  if (origGrace === undefined) delete process.env.TOKMIZER_OFFLINE_GRACE_MS;
  else process.env.TOKMIZER_OFFLINE_GRACE_MS = origGrace;
});

function st(extra: Partial<State>): State {
  return {
    token: "t",
    jwt: "j",
    signingSecret: "s",
    plan: "pro",
    status: "active",
    trialEndsAt: null,
    subEndsAt: null,
    jwtVersion: 1,
    installId: "i",
    email: "x@y",
    ...extra
  };
}

describe("graceExceeded", () => {
  it("is false when absent", () => {
    expect(graceExceeded(st({}))).toBe(false);
  });

  it("is true when older than grace", () => {
    process.env.TOKMIZER_OFFLINE_GRACE_MS = "1000";
    expect(graceExceeded(st({ lastHeartbeatOkAt: Date.now() - 5000 }))).toBe(true);
  });

  it("ignores a past subscription end date", () => {
    expect(graceExceeded(st({ lastHeartbeatOkAt: Date.now(), subEndsAt: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
  });
});
