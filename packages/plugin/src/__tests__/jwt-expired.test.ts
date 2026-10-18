import { describe, expect, it } from "vitest";
import { jwtExpired } from "../license";

function forge(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

describe("jwtExpired", () => {
  it("returns false for a future exp", () => {
    expect(jwtExpired(forge({ exp: Math.floor(Date.now() / 1000) + 3600 }))).toBe(false);
  });

  it("returns true for a past exp", () => {
    expect(jwtExpired(forge({ exp: Math.floor(Date.now() / 1000) - 10 }))).toBe(true);
  });

  it("treats exp within the skew window as expired", () => {
    const jwt = forge({ exp: Math.floor(Date.now() / 1000) + 30 });
    expect(jwtExpired(jwt, 60_000)).toBe(true);
    expect(jwtExpired(jwt, 0)).toBe(false);
  });

  it("returns true for malformed tokens", () => {
    expect(jwtExpired("not-a-jwt")).toBe(true);
    expect(jwtExpired("")).toBe(true);
    expect(jwtExpired("a.b.c")).toBe(true);
    expect(jwtExpired(forge({ noExp: 1 }))).toBe(true);
  });
});
