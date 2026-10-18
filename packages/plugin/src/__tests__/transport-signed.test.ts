import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { consumeSignedJson } from "../transport";

vi.mock("../prod-public-key", () => ({ TOKMIZER_PROD_PUBLIC_KEY_PEM: "" }));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function signBody(body: string, ts: number): string {
  return sign(null, Buffer.from(`${ts}.${body}`, "utf8"), privateKey).toString("base64url");
}

function res(body: string, headers: Record<string, string>): Response {
  return {
    status: 200,
    ok: true,
    headers: new Headers(headers),
    text: () => Promise.resolve(body)
  } as unknown as Response;
}

let origKey: string | undefined;
let origDev: string | undefined;

beforeEach(() => {
  origKey = process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  origDev = process.env.TOKMIZER_DEV;
  process.env.TOKMIZER_DEV = "1";
});

afterEach(() => {
  if (origKey === undefined) delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  else process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = origKey;
  if (origDev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = origDev;
});

describe("consumeSignedJson", () => {
  it("accepts a valid signature when a key is configured", async () => {
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = PUB_PEM;
    const body = JSON.stringify({ plan: "pro" });
    const ts = Date.now();
    const parsed = await consumeSignedJson<{ plan: string }>(
      res(body, { "x-tokmizer-resp-sig": signBody(body, ts), "x-tokmizer-resp-ts": String(ts) })
    );
    expect(parsed.plan).toBe("pro");
  });

  it("rejects an invalid signature when a key is configured", async () => {
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = PUB_PEM;
    const body = JSON.stringify({ plan: "pro" });
    const ts = Date.now();
    await expect(
      consumeSignedJson(
        res(body, { "x-tokmizer-resp-sig": signBody("{\"plan\":\"free\"}", ts), "x-tokmizer-resp-ts": String(ts) })
      )
    ).rejects.toThrow(/invalid server response signature/);
  });

  it("rejects a missing signature when a key is configured", async () => {
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = PUB_PEM;
    const body = JSON.stringify({ plan: "pro" });
    await expect(
      consumeSignedJson(res(body, { "x-tokmizer-resp-ts": String(Date.now()) }))
    ).rejects.toThrow(/missing server response signature/);
  });

  it("rejects a stale resp-ts when a key is configured", async () => {
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = PUB_PEM;
    const body = JSON.stringify({ plan: "pro" });
    const ts = Date.now() - 10 * 60 * 1000;
    await expect(
      consumeSignedJson(
        res(body, { "x-tokmizer-resp-sig": signBody(body, ts), "x-tokmizer-resp-ts": String(ts) })
      )
    ).rejects.toThrow(/stale server response/);
  });

  it("rejects a resp-ts more than two minutes in the future", async () => {
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = PUB_PEM;
    const body = JSON.stringify({ plan: "pro" });
    const ts = Date.now() + 3 * 60 * 1000;
    await expect(
      consumeSignedJson(
        res(body, { "x-tokmizer-resp-sig": signBody(body, ts), "x-tokmizer-resp-ts": String(ts) })
      )
    ).rejects.toThrow(/server response/);
  });

  it("tolerates a small clock skew into the future", async () => {
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = PUB_PEM;
    const body = JSON.stringify({ plan: "pro" });
    const ts = Date.now() + 60 * 1000;
    await expect(
      consumeSignedJson(res(body, { "x-tokmizer-resp-sig": signBody(body, ts), "x-tokmizer-resp-ts": String(ts) }))
    ).resolves.toEqual({ plan: "pro" });
  });

  it("fails closed when no signing key is configured", async () => {
    delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
    delete process.env.TOKMIZER_DEV;
    const body = JSON.stringify({ plan: "pro" });
    await expect(consumeSignedJson(res(body, {}))).rejects.toThrow(/no signing public key/);
  });

  it("fails closed even with TOKMIZER_DEV=1 when no key is configured", async () => {
    delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
    process.env.TOKMIZER_DEV = "1";
    const body = JSON.stringify({ plan: "pro" });
    await expect(consumeSignedJson(res(body, {}))).rejects.toThrow(/no signing public key/);
    delete process.env.TOKMIZER_DEV;
  });

  it("ignores the env key override when TOKMIZER_DEV is not set", async () => {
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = PUB_PEM;
    delete process.env.TOKMIZER_DEV;
    const body = JSON.stringify({ plan: "pro" });
    const ts = Date.now();
    await expect(
      consumeSignedJson(
        res(body, { "x-tokmizer-resp-sig": signBody(body, ts), "x-tokmizer-resp-ts": String(ts) })
      )
    ).rejects.toThrow(/no signing public key/);
    process.env.TOKMIZER_DEV = "1";
  });
});
