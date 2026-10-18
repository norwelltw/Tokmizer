import { describe, it, expect } from "vitest";
import { encryptBundle, decryptBundle } from "../bundle-crypto";

describe("bundle-crypto", () => {
  it("round-trips plaintext under the same device secret", () => {
    const pt = JSON.stringify({ filters: [{ slug: "git", match_command: "^git" }] });
    const enc = encryptBundle(pt, "device-secret-A");
    expect(enc).not.toContain("git");
    expect(enc).not.toContain("match_command");
    expect(decryptBundle(enc, "device-secret-A")).toBe(pt);
  });

  it("fails to decrypt with a different device secret", () => {
    const enc = encryptBundle("hello", "device-secret-A");
    expect(() => decryptBundle(enc, "device-secret-B")).toThrow();
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const enc = encryptBundle("hello", "device-secret-A");
    const buf = Buffer.from(enc, "base64url");
    buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptBundle(buf.toString("base64url"), "device-secret-A")).toThrow();
  });
});
