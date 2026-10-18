import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatingPlan, gatingBonus, graceExceeded } from "../entitlement";
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

describe("gatingPlan", () => {
  it("returns the real plan when lastHeartbeatOkAt is recent", () => {
    expect(gatingPlan(st({ plan: "pro", lastHeartbeatOkAt: Date.now() }))).toBe("pro");
  });

  it("returns the real plan when lastHeartbeatOkAt is absent (back-compat)", () => {
    expect(gatingPlan(st({ plan: "pro" }))).toBe("pro");
  });

  it("keeps the plan even when older than the grace window", () => {
    process.env.TOKMIZER_OFFLINE_GRACE_MS = "1000";
    expect(gatingPlan(st({ plan: "pro", lastHeartbeatOkAt: Date.now() - 5000 }))).toBe("pro");
  });

  it("keeps the plan just inside the grace window", () => {
    process.env.TOKMIZER_OFFLINE_GRACE_MS = "60000";
    expect(gatingPlan(st({ plan: "smart", lastHeartbeatOkAt: Date.now() - 1000 }))).toBe("smart");
  });

  it("keeps the plan even once subEndsAt has passed", () => {
    process.env.TOKMIZER_OFFLINE_GRACE_MS = "60000";
    expect(
      gatingPlan(
        st({
          plan: "pro",
          lastHeartbeatOkAt: Date.now(),
          subEndsAt: new Date(Date.now() - 1000).toISOString()
        })
      )
    ).toBe("pro");
  });

  it("keeps a paid plan while subEndsAt is still in the future", () => {
    expect(
      gatingPlan(
        st({
          plan: "pro",
          lastHeartbeatOkAt: Date.now(),
          subEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString()
        })
      )
    ).toBe("pro");
  });
});

describe("gatingBonus", () => {
  it("keeps bonus when recent", () => {
    expect(gatingBonus(st({ bonusActive: true, lastHeartbeatOkAt: Date.now() }))).toBe(true);
  });

  it("keeps bonus even when grace exceeded", () => {
    process.env.TOKMIZER_OFFLINE_GRACE_MS = "1000";
    expect(gatingBonus(st({ bonusActive: true, lastHeartbeatOkAt: Date.now() - 5000 }))).toBe(true);
  });

  it("keeps bonus when lastHeartbeatOkAt absent (back-compat)", () => {
    expect(gatingBonus(st({ bonusActive: true }))).toBe(true);
  });
});

describe("graceExceeded", () => {
  it("is false when absent", () => {
    expect(graceExceeded(st({}))).toBe(false);
  });

  it("is true when older than grace", () => {
    process.env.TOKMIZER_OFFLINE_GRACE_MS = "1000";
    expect(graceExceeded(st({ lastHeartbeatOkAt: Date.now() - 5000 }))).toBe(true);
  });
});
