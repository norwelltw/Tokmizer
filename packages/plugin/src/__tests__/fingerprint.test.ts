import { describe, expect, it } from "vitest";
import { buildFingerprint } from "../fingerprint";

describe("buildFingerprint", () => {
  it("returns 64-char hex + uuid install-id + signal fields", async () => {
    const f = await buildFingerprint();
    expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(f.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(typeof f.hostname).toBe("string");
    expect(typeof f.os).toBe("string");
    expect(f.cpuCores).toBeGreaterThan(0);
  });

  it("is stable across two consecutive calls", async () => {
    const a = await buildFingerprint();
    const b = await buildFingerprint();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.installId).toBe(b.installId);
  });
});
