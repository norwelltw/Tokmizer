import { createHash, createPublicKey, verify } from "node:crypto";
import { TOKMIZER_CONTENT_PUBLIC_KEY_PEM } from "./content-public-key";

export function contentSigningMessage(slug: string, version: number, position: number, count: number, body: string): Buffer {
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return Buffer.from(`tokmizer-bundle-v1\n${slug}\n${version}\n${position}\n${count}\n${digest}`, "utf8");
}

function contentPublicKeyPem(): string {
  const devOverride =
    process.env.TOKMIZER_RELEASE_BUILD !== "1" && process.env.TOKMIZER_DEV === "1"
      ? process.env.TOKMIZER_CONTENT_PUBLIC_KEY_PEM
      : undefined;
  return (devOverride ?? TOKMIZER_CONTENT_PUBLIC_KEY_PEM).replace(/\\n/g, "\n");
}

export function verifyContentSignature(message: Buffer, sigB64u: unknown, pem: string = contentPublicKeyPem()): boolean {
  if (typeof sigB64u !== "string") return false;
  try {
    return verify(null, message, createPublicKey({ key: pem, format: "pem" }), Buffer.from(sigB64u, "base64url"));
  } catch {
    return false;
  }
}
