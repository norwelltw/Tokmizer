import os from "node:os";
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("device hashes", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("keys the reported hashes with the install ID and keeps the fingerprint formula", async () => {
      vi.spyOn(os, "networkInterfaces").mockReturnValue({ en0: [{ address: "10.0.0.2", netmask: "255.0.0.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: null }] });
      vi.spyOn(os, "userInfo").mockReturnValue({ username: "alice", uid: 1, gid: 1, shell: null, homedir: "/home/alice" });
      const sha = (s: string) => createHash("sha256").update(s).digest("hex");
      const f = await buildFingerprint();
      const cpus = os.cpus();
      const composite = [os.hostname(), os.platform(), os.release(), cpus[0]?.model ?? "unknown", String(cpus.length), sha("aa:bb:cc:dd:ee:ff"), sha("alice"), f.installId].join("|");
      expect(f.fingerprint).toBe(sha(composite));
      expect(f.macHash).toBe(createHmac("sha256", f.installId).update("aa:bb:cc:dd:ee:ff").digest("hex"));
      expect(f.usernameHash).toBe(createHmac("sha256", f.installId).update("alice").digest("hex"));
      expect(f.macHash).not.toBe(sha("aa:bb:cc:dd:ee:ff"));
      expect(f.usernameHash).not.toBe(sha("alice"));
    });
  });
});
