import type { Settings, Plan } from "./contracts";
import { baseUrlFromEnv } from "./base-url";
import { loadState } from "./state";
import { buildFingerprint } from "./fingerprint";
import { fetchSigned, consumeSignedJson } from "./transport";
import { loadSettingsCache, saveSettingsCache, updateSettingsCache } from "./settings-cache";
import { networkEnabled } from "./network";

type SettingsEnvelope = { plan: Plan; settings: Settings };

async function call(method: "GET" | "PATCH", body?: unknown): Promise<SettingsEnvelope> {
  const state = await loadState();
  if (!networkEnabled() || !state || state.linked === false) {
    const plan = state?.plan ?? "free";
    if (method === "GET") return { plan, settings: await loadSettingsCache() };
    const settings = await updateSettingsCache(body);
    return { plan, settings };
  }
  const baseUrl = baseUrlFromEnv();
  const fp = await buildFingerprint();
  const res = await fetchSigned(method, "/api/v1/settings", body, {
    baseUrl,
    bearer: state.jwt,
    signingSecret: state.signingSecret,
    fingerprint: fp.fingerprint,
    installId: fp.installId,
    timeoutMs: 8000
  });
  if (!res.ok) throw new Error(`Settings ${method} failed: ${res.status}`);
  const env = await consumeSignedJson<SettingsEnvelope>(res);
  await saveSettingsCache(env.settings);
  return env;
}

export async function getSettings(): Promise<SettingsEnvelope> {
  return call("GET");
}

export async function patchSettings(patch: Partial<Settings>): Promise<SettingsEnvelope> {
  return call("PATCH", patch);
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) {
    throw new Error(`invalid settings key: ${path}`);
  }
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

export function buildPatchFromArg(key: string, rawValue: string): Partial<Settings> {
  const value = coerce(rawValue);
  const out: Record<string, unknown> = {};
  setByPath(out, key, value);
  return out as Partial<Settings>;
}
