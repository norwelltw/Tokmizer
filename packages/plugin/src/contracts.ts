import { z } from "zod";
import { createHash } from "node:crypto";

export type Plan = "trial" | "free" | "smart" | "pro";
export type TokenStatus = "active" | "suspended" | "revoked";

export const OutputVerbosity = z.enum(["normal", "compact", "minimal"]);
export type OutputVerbosity = z.infer<typeof OutputVerbosity>;

export const ReducerLevel = z.enum(["off", "light", "balanced", "max"]);
export type ReducerLevel = z.infer<typeof ReducerLevel>;

export const Settings = z.object({
  enabled: z.boolean().default(true),
  telemetryOptIn: z.boolean().default(true),
  outputVerbosity: OutputVerbosity.default("compact"),
  reducer: ReducerLevel.default("off"),
  filters: z
    .object({
      enableAll: z.boolean().default(true),
      disabled: z.array(z.string().max(64)).max(100).default([])
    })
    .default({ enableAll: true, disabled: [] })
});
export type Settings = z.infer<typeof Settings>;

export type FingerprintSignals = {
  fingerprint: string;
  installId: string;
};

export type ActivateRequest = FingerprintSignals & {
  token: string;
  email?: string;
  pluginVersion: string;
  timeZone?: string;
  previousToken?: string;
  internal?: true;
};

export type ActivateResponse = {
  jwt: string;
  signingSecret: string;
  plan: Plan;
  status: TokenStatus;
  trialEndsAt: string | null;
  subEndsAt: string | null;
  jwtVersion: number;
  boundEmail?: string | null;
  allowedFilters?: string[];
};

export type EnrollRequest = FingerprintSignals & {
  pluginVersion: string;
  timeZone?: string;
  internal?: true;
};

export type EnrollResponse = ActivateResponse & {
  token: string;
};

export type ClientHealth = {
  shimFallbacks?: number;
  staleShims?: number;
  brokenHooks?: number;
  globalPathLines?: number;
  healed?: number;
  failOpen?: boolean;
};

export type HeartbeatRequest = {
  ts: number;
  localDate?: string;
  timeZone?: string;
  health?: ClientHealth;
};

export type HeartbeatResponse = {
  jwt: string;
  plan: Plan;
  status: TokenStatus;
  statusReason?: string | null;
  trialEndsAt: string | null;
  subEndsAt: string | null;
  jwtVersion: number;
  settingsRevision: number;
  latestPluginVersion: string;
  bonusActive: boolean;
  bonusResetAt?: string;
  allowedFilters?: string[];
  failOpen?: boolean;
};

export type SkillBundleResponse = {
  bundles: {
    slug: string;
    version: number;
    fragments: {
      position: number;
      body: string;
      hash: string;
    }[];
  }[];
};

const SLUG_KEY_CACHE = new Map<string, string>();

export function slugKey(slug: string): string {
  let k = SLUG_KEY_CACHE.get(slug);
  if (!k) {
    k = createHash("sha256").update(`tkr:${slug}`).digest("hex").slice(0, 16);
    SLUG_KEY_CACHE.set(slug, k);
  }
  return k;
}
