import { createHash } from "node:crypto";
import { TOKMIZER_PROD_PUBLIC_KEY_PEM } from "../dist/prod-public-key.js";

const EXPECTED_SHA256 = "de02c650546e7ad6e55b23071f7491fc9ef084b0e565afac1a8d365508dd7e69";

const pem = String(TOKMIZER_PROD_PUBLIC_KEY_PEM);

if (!pem.includes("BEGIN PUBLIC KEY")) {
  console.error(
    "tkr publish guard: prod response-signing public key missing from dist/prod-public-key.js — refusing to publish an unauthenticated client."
  );
  process.exit(1);
}

const actual = createHash("sha256").update(pem, "utf8").digest("hex");
if (actual !== EXPECTED_SHA256) {
  console.error(
    `tkr publish guard: prod public key fingerprint mismatch — expected ${EXPECTED_SHA256}, got ${actual}. Refusing to publish a client trusting the wrong signer.`
  );
  process.exit(1);
}

console.log("tkr publish guard: prod public key present and fingerprint pinned.");
