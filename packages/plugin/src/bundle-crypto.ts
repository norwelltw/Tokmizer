import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const SALT = Buffer.from("tokmizer-bundle-enc-v1");
const INFO = Buffer.from("rules-bundle");

function deriveBundleKey(signingSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(signingSecret, "utf8"), SALT, INFO, 32));
}

export function encryptBundle(plaintext: string, signingSecret: string): string {
  const key = deriveBundleKey(signingSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64url");
}

export function decryptBundle(encoded: string, signingSecret: string): string {
  const key = deriveBundleKey(signingSecret);
  const buf = Buffer.from(encoded, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
