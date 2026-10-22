import os from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFingerprint } from "../fingerprint";

describe("buildFingerprint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns only the install ID and its hash", async () => {
    const f = await buildFingerprint();
    expect(Object.keys(f).sort()).toEqual(["fingerprint", "installId"]);
    expect(f.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(f.fingerprint).toBe(createHash("sha256").update(f.installId).digest("hex"));
  });

  it("is stable across two consecutive calls", async () => {
    const a = await buildFingerprint();
    const b = await buildFingerprint();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.installId).toBe(b.installId);
  });

  it("reads nothing from the machine", async () => {
    const spies = [
      vi.spyOn(os, "hostname"),
      vi.spyOn(os, "release"),
      vi.spyOn(os, "cpus"),
      vi.spyOn(os, "networkInterfaces"),
      vi.spyOn(os, "userInfo")
    ];
    await buildFingerprint();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
