import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { saveBundleCache, loadBundleCache, bundleCachePath } from "../daemon/bundle-cache";
import { runtimeFromCache } from "../daemon/runtime";
import { encryptBundle } from "../bundle-crypto";

vi.mock("../state", () => ({
  loadState: vi.fn().mockResolvedValue({ jwt: "jwt", signingSecret: "sec", token: "tok_x" })
}));

let privateKey: KeyObject;
let origPub: string | undefined;
let origDev: string | undefined;

function signedEnvelope(signedAt: number): { payload: string; signature: string; enc: "v1" } {
  const bundle = {
    bundleVersion: 7,
    signedAt,
    filters: [
      {
        slug: "git",
        match_command: "^git(?:\\s|$)",
        priority: 50,
        strip_ansi: false,
        strip_lines_matching: [],
        keep_failures: false,
        fold_passing: false,
        mask_abs_paths: false,
        preserve_exact: false,
        scale_with_level: true,
        max_lines: 80
      }
    ]
  };
  const payload = encryptBundle(JSON.stringify(bundle), "sec");
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
  return { payload, signature, enc: "v1" };
}

beforeEach(() => {
  origPub = process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  origDev = process.env.TOKMIZER_DEV;
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = pair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  process.env.TOKMIZER_DEV = "1";
});

afterEach(() => {
  if (origPub === undefined) delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  else process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = origPub;
  if (origDev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = origDev;
});

describe("bundle cache persistence", () => {
  it("round-trips a saved envelope with 0600 permissions", () => {
    const env = signedEnvelope(Date.now());
    saveBundleCache(env);
    expect(existsSync(bundleCachePath())).toBe(true);
    expect(statSync(bundleCachePath()).mode & 0o777).toBe(0o600);
    const loaded = loadBundleCache();
    expect(loaded?.payload).toBe(env.payload);
    expect(loaded?.signature).toBe(env.signature);
  });

  it("returns null on a corrupt cache file", () => {
    writeFileSync(bundleCachePath(), "not json");
    chmodSync(bundleCachePath(), 0o600);
    expect(loadBundleCache()).toBeNull();
  });
});

describe("runtimeFromCache", () => {
  it("rebuilds a working runtime from the cached envelope", async () => {
    saveBundleCache(signedEnvelope(Date.now()));
    const rt = await runtimeFromCache();
    expect(rt).not.toBeNull();
    expect(rt!.ruleCount).toBe(1);
    expect(rt!.selectFor("git status", "trial")?.slug).toBe("git");
    expect(rt!.selectFor("npm install", "trial")).toBeNull();
  });

  it("refuses a cached bundle older than the max age", async () => {
    saveBundleCache(signedEnvelope(Date.now() - 8 * 24 * 60 * 60 * 1000));
    expect(await runtimeFromCache()).toBeNull();
  });

  it("refuses a tampered cached payload", async () => {
    const env = signedEnvelope(Date.now());
    saveBundleCache({ ...env, payload: env.payload.slice(0, -4) + "AAAA" });
    expect(await runtimeFromCache()).toBeNull();
  });
});

describe("daemon resolver falls back to the cached bundle", () => {
  it("resolves a filter in-process when the daemon is unreachable", async () => {
    vi.resetModules();
    vi.doMock("../daemon/client", () => ({
      connectDaemon: vi.fn().mockRejectedValue(new Error("no daemon"))
    }));
    saveBundleCache(signedEnvelope(Date.now()));
    const { installDaemonResolver, closeDaemonResolver } = await import("../daemon/resolver");
    const engine = await import("../engine");
    try {
      installDaemonResolver("free");
      const out = await engine.processOutput("git status", "a\n".repeat(200), null, { exitCode: 0 });
      expect(out.filterId).toBe("git");
      expect(out.filteredBytes).toBeLessThan(out.rawBytes);
    } finally {
      closeDaemonResolver();
      engine.setFilterResolver(null);
      vi.doUnmock("../daemon/client");
      vi.resetModules();
    }
  });
});
