import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentSigningMessage, fetchAndVerifyBundles } from "../bundle";
import { consumeSignedJson } from "../transport";

const h = vi.hoisted(() => ({ contentPem: "" }));

vi.mock("../prod-public-key", () => ({ TOKMIZER_PROD_PUBLIC_KEY_PEM: "" }));
vi.mock("../content-public-key", () => ({
  get TOKMIZER_CONTENT_PUBLIC_KEY_PEM() {
    return h.contentPem;
  }
}));
vi.mock("../transport", () => ({
  fetchSigned: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
  consumeSignedJson: vi.fn(),
  respPublicKeyPem: () => (process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM ?? "").replace(/\\n/g, "\n")
}));
vi.mock("../state", () => ({
  loadState: vi.fn().mockResolvedValue({ jwt: "jwt", signingSecret: "sec" })
}));
vi.mock("../fingerprint", () => ({
  buildFingerprint: vi.fn().mockResolvedValue({ fingerprint: "fp", installId: "iid" })
}));

type Fragment = { position: number; body: string; hash: string; contentSig?: string };
type Bundle = { slug: string; version: number; fragments: Fragment[] };

let origPub: string | undefined;
let respKey: KeyObject;
let contentKey: KeyObject;

beforeEach(() => {
  origPub = process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  const resp = generateKeyPairSync("ed25519");
  respKey = resp.privateKey;
  process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = resp.publicKey.export({ type: "spki", format: "pem" }).toString();
  const content = generateKeyPairSync("ed25519");
  contentKey = content.privateKey;
  h.contentPem = content.publicKey.export({ type: "spki", format: "pem" }).toString();
});

afterEach(() => {
  if (origPub === undefined) delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  else process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = origPub;
  vi.mocked(consumeSignedJson).mockReset();
});

function respSig(body: string): string {
  return sign(null, Buffer.from(body, "utf8"), respKey).toString("base64url");
}

function contentSig(slug: string, version: number, position: number, count: number, body: string, key = contentKey): string {
  return sign(null, contentSigningMessage(slug, version, position, count, body), key).toString("base64url");
}

function signedBundle(slug: string, version: number, bodies: string[]): Bundle {
  return {
    slug,
    version,
    fragments: bodies.map((body, position) => ({
      position,
      body,
      hash: respSig(body),
      contentSig: contentSig(slug, version, position, bodies.length, body)
    }))
  };
}

function unsignedBundle(slug: string, version: number, bodies: string[]): Bundle {
  return { slug, version, fragments: bodies.map((body, position) => ({ position, body, hash: respSig(body) })) };
}

function serve(...bundles: Bundle[]) {
  vi.mocked(consumeSignedJson).mockResolvedValue({ bundles });
}

function diagnostic(): { status: string } {
  return JSON.parse(readFileSync(join(process.env.TOKMIZER_HOME!, "content-signature.json"), "utf8"));
}

describe("contentSigningMessage", () => {
  it("binds the format, slug, version, position, count and body digest", () => {
    const digest = createHash("sha256").update("héllo", "utf8").digest("hex");
    expect(contentSigningMessage("power", 4, 1, 7, "héllo").toString("utf8")).toBe(
      `tokmizer-bundle-v1\npower\n4\n1\n7\n${digest}`
    );
  });
});

describe("fetchAndVerifyBundles content signatures", () => {
  it("accepts a fully signed response and records the verified status", async () => {
    serve(signedBundle("power", 4, ["a", "b", "c"]), signedBundle("tkr-command", 1, ["x"]));
    const out = await fetchAndVerifyBundles("https://example.test");
    expect(out).toEqual([
      { slug: "power", version: 4, body: "a\n\nb\n\nc" },
      { slug: "tkr-command", version: 1, body: "x" }
    ]);
    expect(diagnostic().status).toBe("verified");
  });

  it("rejects a response where no fragment carries a content signature", async () => {
    serve(unsignedBundle("power", 4, ["a", "b"]));
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch on power\[0\]/);
  });

  it("rejects a body re-signed only with the response key", async () => {
    const b = signedBundle("power", 4, ["a", "b"]);
    b.fragments[1]!.body = "evil";
    b.fragments[1]!.hash = respSig("evil");
    serve(b);
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch on power\[1\]/);
  });

  it("rejects content signed by another key", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    const b = signedBundle("power", 4, ["a"]);
    b.fragments[0]!.contentSig = contentSig("power", 4, 0, 1, "a", other);
    serve(b);
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch/);
  });

  it("rejects a fragment moved to another slug", async () => {
    const src = signedBundle("reducer-max", 2, ["rules"]);
    serve({ slug: "power", version: 2, fragments: src.fragments });
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch on power\[0\]/);
  });

  it("rejects a version change", async () => {
    const b = signedBundle("power", 4, ["a"]);
    serve({ ...b, version: 5 });
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch/);
  });

  it("rejects swapped fragment positions", async () => {
    const b = signedBundle("power", 4, ["a", "b"]);
    const [f0, f1] = b.fragments;
    serve({ ...b, fragments: [{ ...f0!, position: 1 }, { ...f1!, position: 0 }] });
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch/);
  });

  it("rejects a dropped fragment", async () => {
    const b = signedBundle("power", 4, ["a", "b", "c"]);
    serve({ ...b, fragments: [b.fragments[0]!, b.fragments[1]!] });
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch/);
  });

  it("rejects a missing position", async () => {
    const b = signedBundle("power", 4, ["a", "b", "c"]);
    serve({ ...b, fragments: [b.fragments[0]!, b.fragments[2]!] });
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/inconsistent fragments on power/);
  });

  it("rejects a duplicated position", async () => {
    const b = signedBundle("power", 4, ["a", "b"]);
    serve({ ...b, fragments: [b.fragments[0]!, b.fragments[0]!, b.fragments[1]!] });
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/inconsistent fragments on power/);
  });

  it("rejects an empty bundle once content signatures are in use", async () => {
    serve(signedBundle("power", 4, ["a"]), { slug: "tkr-command", version: 1, fragments: [] });
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/inconsistent fragments on tkr-command/);
  });

  it("rejects an unsigned bundle mixed with signed ones", async () => {
    serve(signedBundle("power", 4, ["a"]), unsignedBundle("tkr-command", 1, ["x"]));
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch on tkr-command\[0\]/);
  });

  it("rejects one unsigned fragment inside a signed bundle", async () => {
    const b = signedBundle("power", 4, ["a", "b"]);
    delete b.fragments[1]!.contentSig;
    serve(b);
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch on power\[1\]/);
  });

  it("treats an empty content signature as present and invalid", async () => {
    const b = unsignedBundle("power", 4, ["a"]);
    b.fragments[0]!.contentSig = "";
    serve(b);
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/content signature mismatch/);
  });

  it("still checks the response-key signature", async () => {
    const b = signedBundle("power", 4, ["a"]);
    b.fragments[0]!.hash = respSig("other");
    serve(b);
    await expect(fetchAndVerifyBundles("https://example.test")).rejects.toThrow(/fragment signature mismatch/);
  });
});
