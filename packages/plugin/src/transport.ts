import { createHmac, createPublicKey, verify } from "node:crypto";
import { PLUGIN_VERSION } from "./version";
import { TOKMIZER_PROD_PUBLIC_KEY_PEM } from "./prod-public-key";
import { assertNetworkEnabled } from "./network";

const RESP_MAX_AGE_MS = 5 * 60 * 1000;

export function respPublicKeyPem(): string {
  const devOverride =
    process.env.TOKMIZER_RELEASE_BUILD !== "1" && process.env.TOKMIZER_DEV === "1"
      ? process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM
      : undefined;
  return (devOverride ?? TOKMIZER_PROD_PUBLIC_KEY_PEM).replace(/\\n/g, "\n");
}

function verifyResponseBody(body: string, ts: number, sigB64u: string, pem: string): boolean {
  try {
    const publicKey = createPublicKey({ key: pem, format: "pem" });
    return verify(null, Buffer.from(`${ts}.${body}`, "utf8"), publicKey, Buffer.from(sigB64u, "base64url"));
  } catch {
    return false;
  }
}

export async function consumeSignedJson<T>(res: Response): Promise<T> {
  const body = await res.text();
  const pem = respPublicKeyPem();
  const tsHeader = res.headers?.get?.("x-tokmizer-resp-ts") ?? null;
  if (tsHeader !== null) {
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Date.now() - ts > RESP_MAX_AGE_MS) {
      throw new TransportError("http", "stale server response (resp-ts outside freshness window)");
    }
  }
  if (!pem || !pem.includes("BEGIN PUBLIC KEY")) {
    throw new TransportError(
      "http",
      "no signing public key configured; refusing to trust server response"
    );
  }
  const sig = res.headers?.get?.("x-tokmizer-resp-sig") ?? null;
  const ts = Number(tsHeader);
  if (!sig || tsHeader === null || !Number.isFinite(ts)) {
    throw new TransportError("http", "missing server response signature");
  }
  if (!verifyResponseBody(body, ts, sig, pem)) {
    throw new TransportError("http", "invalid server response signature");
  }
  return JSON.parse(body) as T;
}

export type TransportOpts = {
  baseUrl: string;
  bearer?: string;
  signingSecret?: string;
  fingerprint: string;
  installId: string;
  timeoutMs?: number;
};

export class TransportError extends Error {
  constructor(public kind: "timeout" | "network" | "http", message: string, public status?: number) {
    super(message);
    this.name = "TransportError";
  }
}

function hmacHex(body: string, ts: number, secret: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

export async function fetchSigned(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  opts: TransportOpts
): Promise<Response> {
  assertNetworkEnabled();
  const ts = Date.now();
  const text = body === undefined ? "" : JSON.stringify(body);
  const sig = opts.signingSecret ? hmacHex(text, ts, opts.signingSecret) : "0".repeat(64);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tokmizer-fingerprint": opts.fingerprint,
    "x-tokmizer-install-id": opts.installId,
    "x-tokmizer-sig": sig,
    "x-tokmizer-ts": String(ts),
    "x-tokmizer-plugin-version": PLUGIN_VERSION
  };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const hasBody = method !== "GET" && method !== "DELETE";
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (hasBody) init.body = text;
  try {
    return await fetch(`${opts.baseUrl}${path}`, init);
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new TransportError("timeout", `${method} ${path} timed out after ${timeoutMs}ms`);
    }
    throw new TransportError("network", `${method} ${path} failed: ${(err as Error).message}`);
  }
}
