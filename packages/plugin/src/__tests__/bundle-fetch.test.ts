import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { fetchAndVerifyBundles } from "../bundle";
import { consumeSignedJson } from "../transport";

vi.mock("../prod-public-key", () => ({ TOKMIZER_PROD_PUBLIC_KEY_PEM: "" }));
vi.mock("../transport", () => ({
  fetchSigned: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
  consumeSignedJson: vi.fn(),
  respPublicKeyPem: () =>
    (process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM ?? "").replace(/\\n/g, "\n")
}));
vi.mock("../state", () => ({
  loadState: vi.fn().mockResolvedValue({ jwt: "jwt", signingSecret: "sec" })
}));
vi.mock("../fingerprint", () => ({
  buildFingerprint: vi.fn().mockResolvedValue({ fingerprint: "fp", installId: "iid" })
}));

let origPub: string | undefined;
let privatePem: string;

beforeEach(() => {
  origPub = process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

afterEach(() => {
  if (origPub === undefined) delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  else process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = origPub;
  vi.mocked(consumeSignedJson).mockReset();
});

function signBody(body: string): string {
  const pk = createPrivateKey({ key: privatePem, format: "pem" });
  return sign(null, Buffer.from(body, "utf8"), pk).toString("base64url");
}

function envelope(slug: string, body: string) {
  return {
    bundles: [
      { slug, version: 1, fragments: [{ position: 0, body, hash: signBody(body) }] }
    ]
  };
}

describe("fetchAndVerifyBundles", () => {
  it("assembles bundles from the signature-verified envelope", async () => {
    vi.mocked(consumeSignedJson).mockResolvedValue(envelope("power-command", "the body"));
    const out = await fetchAndVerifyBundles("https://example.test");
    expect(consumeSignedJson).toHaveBeenCalledTimes(1);
    expect(out).toEqual([{ slug: "power-command", version: 1, body: "the body" }]);
  });

  it("rejects slugs unfit for file paths", async () => {
    for (const slug of ["../evil-command", "a/b-command", "..", "Power-Command", ".hidden"]) {
      vi.mocked(consumeSignedJson).mockResolvedValue(envelope(slug, "x"));
      await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(
        /invalid bundle slug/
      );
    }
  });

  it("rejects a tampered fragment body", async () => {
    const env = envelope("power", "clean");
    env.bundles[0].fragments[0].body = "tampered";
    vi.mocked(consumeSignedJson).mockResolvedValue(env);
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(
      /signature mismatch/
    );
  });
});
