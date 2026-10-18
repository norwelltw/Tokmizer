import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { build } from "esbuild";
import { releaseDefines } from "../../scripts/bundle-config.mjs";
import { respPublicKeyPem } from "../transport";
import { TOKMIZER_PROD_PUBLIC_KEY_PEM } from "../prod-public-key";
import { baseUrlFromEnv } from "../license";

const PLUGIN_DIR = resolve(__dirname, "../..");
const OTHER_PEM = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "tkr-trust-"));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("response signing key", () => {
  it("keeps the developer key override when running from source", () => {
    vi.stubEnv("TOKMIZER_DEV", "1");
    vi.stubEnv("TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM", OTHER_PEM);
    expect(respPublicKeyPem()).toBe(OTHER_PEM);
  });

  it("ignores the environment in a released build and trusts only the compiled production key", async () => {
    const outfile = join(out, "transport.mjs");
    await build({
      entryPoints: [join(PLUGIN_DIR, "src/transport.ts")],
      outfile,
      bundle: true,
      minify: true,
      define: releaseDefines,
      platform: "node",
      format: "esm",
      target: "node18",
      logLevel: "silent"
    });
    expect(readFileSync(outfile, "utf8")).not.toContain("TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM");
    vi.stubEnv("TOKMIZER_DEV", "1");
    vi.stubEnv("TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM", OTHER_PEM);
    const built = (await import(pathToFileURL(outfile).href)) as typeof import("../transport");
    expect(built.respPublicKeyPem()).toBe(TOKMIZER_PROD_PUBLIC_KEY_PEM);
  });
});

describe("TOKMIZER_BASE_URL", () => {
  it.each([
    [undefined, "https://tokmizer.com"],
    ["https://tokmizer.com", "https://tokmizer.com"],
    ["https://tokmizer.com/", "https://tokmizer.com"],
    ["http://127.0.0.1:3300", "http://127.0.0.1:3300"],
    ["http://localhost:3300", "http://localhost:3300"],
    ["http://localhost", "http://localhost"]
  ])("accepts %s", (value, expected) => {
    if (value === undefined) vi.stubEnv("TOKMIZER_BASE_URL", undefined as unknown as string);
    else vi.stubEnv("TOKMIZER_BASE_URL", value);
    expect(baseUrlFromEnv()).toBe(expected);
  });

  it.each([
    "https://evil.example",
    "http://tokmizer.com",
    "https://tokmizer.com.evil.example",
    "https://tokmizer.com@evil.example",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "http://localhost@evil.example",
    "https://localhost:3300",
    "",
    "not a url"
  ])("falls back to production for %s", (value) => {
    vi.stubEnv("TOKMIZER_BASE_URL", value);
    expect(baseUrlFromEnv()).toBe("https://tokmizer.com");
  });
});
