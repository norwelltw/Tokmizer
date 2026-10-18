import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyFragmentSignature } from "../bundle";

vi.mock("../prod-public-key", () => ({ TOKMIZER_PROD_PUBLIC_KEY_PEM: "" }));

let origPub: string | undefined;
let publicPem: string;
let privatePem: string;

beforeEach(() => {
  origPub = process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = publicPem;
});

afterEach(() => {
  if (origPub === undefined) delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  else process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = origPub;
});

function signBody(body: string): string {
  const { createPrivateKey } = require("node:crypto") as typeof import("node:crypto");
  const pk = createPrivateKey({ key: privatePem, format: "pem" });
  return sign(null, Buffer.from(body, "utf8"), pk).toString("base64url");
}

describe("verifyFragmentSignature", () => {
  it("verifies a freshly signed body", () => {
    const body = "hello world";
    const sig = signBody(body);
    expect(verifyFragmentSignature(body, sig)).toBe(true);
  });

  it("rejects a single-byte tamper", () => {
    const body = "hello world";
    const sig = signBody(body);
    expect(verifyFragmentSignature(body + "!", sig)).toBe(false);
  });

  it("rejects a wrong signature", () => {
    const body = "abc";
    const wrongSig = signBody("other body");
    expect(verifyFragmentSignature(body, wrongSig)).toBe(false);
  });

  it("rejects when signed with a different key", () => {
    const body = "x";
    const { privateKey: otherKey } = generateKeyPairSync("ed25519");
    const sig = sign(null, Buffer.from(body, "utf8"), otherKey).toString("base64url");
    expect(verifyFragmentSignature(body, sig)).toBe(false);
  });

  it("rejects malformed base64url sig (returns false, no throw)", () => {
    expect(verifyFragmentSignature("body", "!!!not valid base64!!!")).toBe(false);
  });

  it("verifies bodies of different positions independently", () => {
    const a = "fragment one";
    const b = "fragment two";
    expect(verifyFragmentSignature(a, signBody(a))).toBe(true);
    expect(verifyFragmentSignature(b, signBody(b))).toBe(true);
    expect(verifyFragmentSignature(a, signBody(b))).toBe(false);
  });

  it("throws clearly when public key env is missing", () => {
    delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
    expect(() => verifyFragmentSignature("x", "y")).toThrow(/no valid signing public key/i);
  });
});
