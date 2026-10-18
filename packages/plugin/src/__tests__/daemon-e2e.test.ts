import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { generateKeyPairSync, sign as signCrypto } from "node:crypto";
import { startServer, type DaemonHandle } from "../daemon/server";
import { connectDaemon, type DaemonClient } from "../daemon/client";
import { encryptBundle } from "../bundle-crypto";

const E2E_SECRET = "e2e-signing-secret-0123456789";

let workDir: string;
let origHome: string | undefined;
let origBaseUrl: string | undefined;
let origPubKey: string | undefined;
let httpServer: HttpServer | null = null;
let daemon: DaemonHandle | null = null;
let client: DaemonClient | null = null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tok-e2e-"));
  origHome = process.env.TOKMIZER_HOME;
  origBaseUrl = process.env.TOKMIZER_BASE_URL;
  origPubKey = process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  process.env.TOKMIZER_HOME = workDir;
});

afterEach(async () => {
  if (client) {
    client.close();
    client = null;
  }
  if (daemon) {
    await daemon.close();
    daemon = null;
  }
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }
  rmSync(workDir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  if (origBaseUrl === undefined) delete process.env.TOKMIZER_BASE_URL;
  else process.env.TOKMIZER_BASE_URL = origBaseUrl;
  if (origPubKey === undefined) delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  else process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = origPubKey;
});

function seedState(): void {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    join(workDir, "state.json"),
    JSON.stringify({
      token: "tok_e2e",
      signingSecret: E2E_SECRET,
      plan: "smart",
      email: "x@y",
      jwt: "test-jwt",
      jwtExp: Date.now() + 60_000,
      pluginVersion: "0.1.0",
      installId: "11111111-1111-1111-1111-111111111111",
      fingerprint: "f".repeat(64),
      status: "active"
    })
  );
}

function makeBundleEnvelope(
  privateKeyPem: string,
  secret: string,
  filters: Array<Record<string, unknown>>,
  signedAt: number = Date.now()
): string {
  const plaintext = JSON.stringify({
    bundleVersion: 7,
    signedAt,
    filters
  });
  const payload = encryptBundle(plaintext, secret);
  const { createPrivateKey } = require("node:crypto") as typeof import("node:crypto");
  const pk = createPrivateKey({ key: privateKeyPem, format: "pem" });
  const sig = signCrypto(null, Buffer.from(payload, "utf8"), pk).toString("base64url");
  return JSON.stringify({ payload, signature: sig, enc: "v1" });
}

async function startMockBackend(envelope: string): Promise<number> {
  return new Promise<number>((resolve) => {
    httpServer = createHttpServer((req, res) => {
      if (req.url?.includes("/api/v1/rules/bundle")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(envelope);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

describe("daemon E2E — hook → daemon → backend", () => {
  it("client.filter() returns a signed filter served by daemon backed by mock backend", async () => {
    seedState();

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = publicPem;

    const envelope = makeBundleEnvelope(privatePem, E2E_SECRET, [
      {
        slug: "git",
        match_command: "^git\\b",
        priority: 50,
        strip_ansi: true,
        strip_lines_matching: []
      }
    ]);
    const port = await startMockBackend(envelope);
    process.env.TOKMIZER_BASE_URL = `http://127.0.0.1:${port}`;

    const socketPath = join(workDir, "test.sock");
    const { fetchBundle } = await import("../daemon/runtime");
    daemon = await startServer(null, {
      socketPath,
      onWarming: () => fetchBundle(process.env.TOKMIZER_BASE_URL!)
    });

    client = await connectDaemon({ socketPath });
    const filter = await client.filter("git status", "smart");
    expect(filter).not.toBeNull();
    expect(filter!.slug).toBe("git");
  }, 15_000);

  it("client.filter() returns null when no rule matches", async () => {
    seedState();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const envelope = makeBundleEnvelope(privatePem, E2E_SECRET, [
      { slug: "git", match_command: "^git\\b", priority: 50, strip_ansi: false, strip_lines_matching: [] }
    ]);
    const port = await startMockBackend(envelope);
    process.env.TOKMIZER_BASE_URL = `http://127.0.0.1:${port}`;

    const socketPath = join(workDir, "test.sock");
    const { fetchBundle } = await import("../daemon/runtime");
    daemon = await startServer(null, {
      socketPath,
      onWarming: () => fetchBundle(process.env.TOKMIZER_BASE_URL!)
    });
    client = await connectDaemon({ socketPath });

    const filter = await client.filter("docker ps", "smart");
    expect(filter).toBeNull();
  }, 15_000);

  it("daemon ping returns ruleCount + bundleVersion after warm-up", async () => {
    seedState();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const envelope = makeBundleEnvelope(privatePem, E2E_SECRET, [
      { slug: "a", match_command: "^a", priority: 50, strip_ansi: false, strip_lines_matching: [] },
      { slug: "b", match_command: "^b", priority: 50, strip_ansi: false, strip_lines_matching: [] }
    ]);
    const port = await startMockBackend(envelope);
    process.env.TOKMIZER_BASE_URL = `http://127.0.0.1:${port}`;

    const socketPath = join(workDir, "test.sock");
    const { fetchBundle } = await import("../daemon/runtime");
    daemon = await startServer(null, {
      socketPath,
      onWarming: () => fetchBundle(process.env.TOKMIZER_BASE_URL!)
    });
    client = await connectDaemon({ socketPath });

    await client.filter("a thing", "smart");

    const info = await client.ping();
    expect(info.bundleVersion).toBe(7);
    expect(info.ruleCount).toBe(2);
  }, 15_000);

  it("rejects a rules bundle whose signedAt is older than the max bundle age", async () => {
    seedState();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const staleSignedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const envelope = makeBundleEnvelope(
      privatePem,
      E2E_SECRET,
      [{ slug: "git", match_command: "^git\\b", priority: 50, strip_ansi: true, strip_lines_matching: [] }],
      staleSignedAt
    );
    const port = await startMockBackend(envelope);
    process.env.TOKMIZER_BASE_URL = `http://127.0.0.1:${port}`;

    const { fetchBundle } = await import("../daemon/runtime");
    await expect(fetchBundle(process.env.TOKMIZER_BASE_URL)).rejects.toThrow(/stale/);
  }, 15_000);

  it("client.filter() with an allowed list selects the best authorized filter", async () => {
    seedState();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const envelope = makeBundleEnvelope(privatePem, E2E_SECRET, [
      { slug: "git", match_command: "^git\\b", priority: 50, strip_ansi: true, strip_lines_matching: [] },
      { slug: "git-premium", match_command: "^git\\b", priority: 90, strip_ansi: true, strip_lines_matching: [] }
    ]);
    const port = await startMockBackend(envelope);
    process.env.TOKMIZER_BASE_URL = `http://127.0.0.1:${port}`;

    const socketPath = join(workDir, "test.sock");
    const { fetchBundle } = await import("../daemon/runtime");
    const { slugKey } = await import("../contracts");
    daemon = await startServer(null, {
      socketPath,
      onWarming: () => fetchBundle(process.env.TOKMIZER_BASE_URL!)
    });

    client = await connectDaemon({ socketPath });
    const unrestricted = await client.filter("git status", "smart");
    expect(unrestricted!.slug).toBe("git-premium");
    const gated = await client.filter("git status", "smart", [slugKey("git")]);
    expect(gated!.slug).toBe("git");
  }, 15_000);
});
