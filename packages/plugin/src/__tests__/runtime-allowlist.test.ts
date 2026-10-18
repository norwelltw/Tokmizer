import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { encryptBundle } from "../bundle-crypto";
import { runtimeFromEnvelope } from "../daemon/runtime";
import { slugKey } from "../contracts";

afterEach(() => vi.unstubAllEnvs());

it("distinguishes an explicit empty allowlist from an unrestricted runtime request", () => {
  const keys = generateKeyPairSync("ed25519");
  vi.stubEnv("TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM", keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const secret = "fixture-runtime-allowlist-secret";
  const payload = encryptBundle(JSON.stringify({ bundleVersion: 1, signedAt: Date.now(), filters: [
    { slug: "git-log", match_command: "^git log", max_lines: 10 }
  ] }), secret);
  const signature = sign(null, Buffer.from(payload), keys.privateKey).toString("base64url");
  const runtime = runtimeFromEnvelope({ payload, signature }, secret);
  expect(runtime.selectFor("git log", "pro")?.slug).toBe("git-log");
  expect(runtime.selectFor("git log", "pro", [])).toBeNull();
  expect(runtime.selectFor("git log", "pro", [slugKey("git-log")])?.slug).toBe("git-log");
});
