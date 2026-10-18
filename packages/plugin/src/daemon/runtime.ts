import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { Plan } from "../contracts";
import { FilterDef } from "../engine/schema";
import { selectFilter } from "../engine/matcher";
import type { LoadedFilter } from "../engine/loader";
import { loadState } from "../state";
import { fetchSigned, respPublicKeyPem } from "../transport";
import { decryptBundle } from "../bundle-crypto";
import { loadBundleCache, saveBundleCache } from "./bundle-cache";

export const BundlePayload = z.object({
  bundleVersion: z.number().int().nonnegative(),
  signedAt: z.number().int(),
  filters: z.array(FilterDef)
});
export type BundlePayload = z.infer<typeof BundlePayload>;

const BundleEnvelope = z.object({
  payload: z.string().min(1),
  signature: z.string().min(1),
  enc: z.literal("v1")
});

const DEFAULT_MAX_BUNDLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function maxBundleAgeMs(): number {
  const raw = Number(process.env.TOKMIZER_MAX_BUNDLE_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BUNDLE_AGE_MS;
}

export type DaemonRuntime = {
  bundleVersion: number;
  signedAt: number;
  ruleCount: number;
  startedAt: number;
  fetchedAt: number;
  selectFor: (cmd: string, plan: Plan, allowed?: string[]) => LoadedFilter | null;
};

export function bundleExpired(rt: DaemonRuntime, now: number = Date.now()): boolean {
  return now - rt.fetchedAt > maxBundleAgeMs();
}

function verifyEnvelope(
  envelope: { payload: string; signature: string },
  signingSecret: string
): unknown {
  const pem = respPublicKeyPem();
  if (!pem || !pem.includes("BEGIN PUBLIC KEY")) {
    throw new Error(
      "tkr-daemon: no valid signing public key configured (set TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM at build time)."
    );
  }
  const publicKey = createPublicKey({ key: pem, format: "pem" });
  const ok = verify(
    null,
    Buffer.from(envelope.payload, "utf8"),
    publicKey,
    Buffer.from(envelope.signature, "base64url")
  );
  if (!ok) throw new Error("tkr-daemon: rules bundle signature invalid");
  return JSON.parse(decryptBundle(envelope.payload, signingSecret));
}

export class BundleFetchError extends Error {
  status: number;
  constructor(status: number) {
    super(`tkr-daemon: bundle fetch failed ${status}`);
    this.status = status;
  }
}

export async function healOn401(
  err: unknown,
  baseUrl: string,
  deps: {
    heartbeat: (baseUrl: string) => Promise<unknown>;
    fetchBundle: (baseUrl: string) => Promise<DaemonRuntime>;
    log: (message: string) => void;
  }
): Promise<DaemonRuntime | null> {
  if (err instanceof BundleFetchError && (err.status === 401 || err.status === 403)) {
    try {
      await deps.heartbeat(baseUrl);
      return await deps.fetchBundle(baseUrl);
    } catch (retryErr) {
      deps.log(`initial fetch failed after heartbeat: ${(retryErr as Error).message}`);
      return null;
    }
  }
  deps.log(`initial fetch failed: ${(err as Error).message}`);
  return null;
}

export async function fetchBundle(baseUrl: string): Promise<DaemonRuntime> {
  const state = await loadState();
  if (!state || !state.jwt) {
    throw new Error("tkr-daemon: not activated (no JWT)");
  }
  if (!state.signingSecret) {
    throw new Error("tkr-daemon: not activated (no signing secret)");
  }

  const res = await fetchSigned("GET", "/api/v1/rules/bundle", undefined, {
    baseUrl,
    bearer: state.jwt,
    signingSecret: state.signingSecret,
    fingerprint: state.fingerprint ?? "0".repeat(64),
    installId: state.installId,
    timeoutMs: 10_000
  });

  if (!res.ok) {
    throw new BundleFetchError(res.status);
  }

  const envelope = BundleEnvelope.parse(await res.json());
  const runtime = runtimeFromEnvelope(envelope, state.signingSecret);
  saveBundleCache(envelope);
  return runtime;
}

export function runtimeFromEnvelope(
  envelope: { payload: string; signature: string },
  signingSecret: string
): DaemonRuntime {
  const verified = verifyEnvelope(envelope, signingSecret);
  const bundle = BundlePayload.parse(verified);

  if (Date.now() - bundle.signedAt > maxBundleAgeMs()) {
    throw new Error("tkr-daemon: rules bundle is stale");
  }

  return compileRuntime(bundle, { signedAt: bundle.signedAt, fetchedAt: Date.now() });
}

export function compileRuntime(
  bundle: BundlePayload,
  at: { signedAt: number; fetchedAt: number }
): DaemonRuntime {
  const loaded = new Map<string, LoadedFilter>();
  for (const f of bundle.filters) {
    loaded.set(f.slug, { ...f, matchRegex: new RegExp(f.match_command) });
  }

  return {
    bundleVersion: bundle.bundleVersion,
    signedAt: at.signedAt,
    ruleCount: loaded.size,
    startedAt: Date.now(),
    fetchedAt: at.fetchedAt,
    selectFor: (cmd, _plan, allowed) =>
      selectFilter(cmd, loaded.values(), allowed ? new Set(allowed) : null, loaded)
  };
}

export async function runtimeFromCache(): Promise<DaemonRuntime | null> {
  try {
    const cached = loadBundleCache();
    if (!cached) return null;
    const state = await loadState();
    if (!state?.signingSecret) return null;
    return runtimeFromEnvelope(cached, state.signingSecret);
  } catch {
    return null;
  }
}
