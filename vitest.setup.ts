import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./vitest.home-guard.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = (key: { export(options: { type: "spki" | "pkcs8"; format: "pem" }): string | Buffer }, type: "spki" | "pkcs8"): string =>
  String(key.export({ type, format: "pem" })).replace(/\n/g, "\\n");

process.env.TOKMIZER_HOME = mkdtempSync(join(tmpdir(), "tkr-vitest-home-"));
process.env.TOKMIZER_AUTO_UPDATE ??= "0";
process.env.TOKMIZER_DEV ??= "1";
process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM ??= pem(publicKey, "spki");
process.env.TOKMIZER_RESP_SIGNING_PRIVATE_KEY_PEM ??= pem(privateKey, "pkcs8");
