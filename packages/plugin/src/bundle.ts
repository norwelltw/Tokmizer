import { createPublicKey, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillBundleResponse } from "./contracts";
import { contentSigningMessage, verifyContentSignature } from "./content-signing";
import { tokmizerHome } from "./paths";
import { fetchSigned, consumeSignedJson, respPublicKeyPem } from "./transport";
import { loadState } from "./state";
import { buildFingerprint } from "./fingerprint";
import { assertNetworkEnabled } from "./network";

export { contentSigningMessage, verifyContentSignature };

export function verifyFragmentSignature(body: string, sigB64u: string): boolean {
  const pem = respPublicKeyPem();
  if (!pem || !pem.includes("BEGIN PUBLIC KEY")) {
    throw new Error(
      "Tokmizer plugin: no valid signing public key. Set TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM or rebuild plugin against a prod key."
    );
  }
  const publicKey = createPublicKey({ key: pem, format: "pem" });
  try {
    const sig = Buffer.from(sigB64u, "base64url");
    return verify(null, Buffer.from(body, "utf8"), publicKey, sig);
  } catch {
    return false;
  }
}

type ServedFragment = SkillBundleResponse["bundles"][number]["fragments"][number] & { contentSig?: string | null };

function assertContentSigned(slug: string, version: number, fragments: ServedFragment[]): void {
  if (fragments.length === 0 || fragments.some((f, i) => f.position !== i)) {
    throw new Error(`incomplete or inconsistent fragments on ${slug}`);
  }
  for (const f of fragments) {
    const message = contentSigningMessage(slug, version, f.position, fragments.length, f.body);
    if (!verifyContentSignature(message, f.contentSig)) {
      throw new Error(`content signature mismatch on ${slug}[${f.position}]`);
    }
  }
}

async function recordContentSignature(status: "verified"): Promise<void> {
  try {
    await mkdir(tokmizerHome(), { recursive: true });
    await writeFile(join(tokmizerHome(), "content-signature.json"), JSON.stringify({ at: Date.now(), status }), { mode: 0o600 });
  } catch {}
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export type AssembledBundle = {
  slug: string;
  version: number;
  body: string;
};

export async function fetchAndVerifyBundles(baseUrl: string): Promise<AssembledBundle[]> {
  assertNetworkEnabled();
  const state = await loadState();
  if (!state) throw new Error("Plugin not activated.");
  const fp = await buildFingerprint();
  const res = await fetchSigned("GET", "/api/v1/skills/bundle", undefined, {
    baseUrl,
    bearer: state.jwt,
    signingSecret: state.signingSecret,
    fingerprint: fp.fingerprint,
    installId: fp.installId,
    timeoutMs: 8000
  });
  if (!res.ok) throw new Error(`bundle fetch failed ${res.status}`);
  const json = await consumeSignedJson<SkillBundleResponse>(res);

  const assembled: AssembledBundle[] = [];
  for (const b of json.bundles) {
    if (!SLUG_RE.test(b.slug)) {
      throw new Error(`invalid bundle slug ${b.slug}`);
    }
    const sorted = [...b.fragments].sort((a, x) => a.position - x.position);
    for (const f of sorted) {
      if (!verifyFragmentSignature(f.body, f.hash)) {
        throw new Error(`fragment signature mismatch on ${b.slug}[${f.position}]`);
      }
    }
    assertContentSigned(b.slug, b.version, sorted);
    assembled.push({
      slug: b.slug,
      version: b.version,
      body: sorted.map((f) => f.body).join("\n\n")
    });
  }
  await recordContentSignature("verified");
  return assembled;
}
