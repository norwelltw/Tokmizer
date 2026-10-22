import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  slugKey,
  type ActivateRequest,
  type ActivateResponse,
  type EnrollRequest,
  type EnrollResponse,
  type HeartbeatRequest,
  type HeartbeatResponse
} from "./contracts";
import { buildFingerprint } from "./fingerprint";
import { loadState, saveState, clearState, detectTimeZone, type State } from "./state";
import { fetchSigned, consumeSignedJson } from "./transport";
import { enrollCooldownFile, tokmizerHome } from "./paths";
import { fetchAndVerifyBundles } from "./bundle";
import { assertNoBundleRollback, recordInstalledVersions } from "./bundle-versions";
import { ALLOWED_COMMAND_NAMES, ALLOWED_SKILL_SLUGS, unsafeBundleContent } from "./bundle-policy";
import {
  writeSkill,
  isFresh,
  pruneSkills,
  installCommand,
  pruneCommands,
  recordBundleRefresh
} from "./cache";
import { pruneContentCache } from "./content-cache";
import { M } from "./ui";
import { getSettings } from "./settings-client";
import { assertNetworkEnabled, networkEnabled } from "./network";
import { collectHealth } from "./client-health";
import { clearShimFallbacks, setFailOpen } from "./shim/heal";

const COMMAND_SLUG_SUFFIX = "-command";
const AUTH_FAIL_HEAL_THRESHOLD = 3;

async function reloadDaemon(): Promise<void> {
  try {
    const { connectDaemon } = await import("./daemon/client");
    const client = await connectDaemon();
    try {
      await client.reload();
    } finally {
      client.close();
    }
  } catch {}
}

export async function refreshBundles(baseUrl: string, force: boolean): Promise<void> {
  if (!force && (await isFresh("power"))) return;
  try {
    const bundles = await fetchAndVerifyBundles(baseUrl);
    await assertNoBundleRollback(bundles);
    const skillSlugs: string[] = [];
    const commandNames: string[] = [];
    const rejected: string[] = [];
    const installed: typeof bundles = [];
    for (const b of bundles) {
      const isCommand = b.slug.endsWith(COMMAND_SLUG_SUFFIX);
      const name = isCommand ? b.slug.slice(0, -COMMAND_SLUG_SUFFIX.length) : b.slug;
      if (!(isCommand ? ALLOWED_COMMAND_NAMES : ALLOWED_SKILL_SLUGS).includes(name)) continue;
      const unsafe = unsafeBundleContent(b.body);
      if (unsafe) rejected.push(`${b.slug} (${unsafe})`);
      else {
        if (isCommand) await installCommand(name, b.body);
        else await writeSkill(name, b.body);
        installed.push(b);
      }
      (isCommand ? commandNames : skillSlugs).push(name);
    }
    await recordInstalledVersions(installed);
    await pruneSkills(skillSlugs);
    await pruneCommands(commandNames);
    await recordBundleRefresh(rejected.length ? `unsafe bundle skipped: ${rejected.join(", ")}` : null);
  } catch (err) {
    await recordBundleRefresh(err instanceof Error ? err.message : String(err));
  }
  try {
    await pruneContentCache();
  } catch {}
}

import { PLUGIN_VERSION } from "./version";
import { baseUrlFromEnv } from "./base-url";

export type ActivateInput = {
  token: string;
  email?: string;
  baseUrl: string;
};

async function withRetry<T>(fn: () => Promise<T>, opts: { attempts: number }): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === opts.attempts - 1) break;
      const delay = 500 * Math.pow(3, i) + Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function internalMarker(): { internal?: true } {
  return process.env.TOKMIZER_INTERNAL === "1" ? { internal: true } : {};
}

export async function activate(input: ActivateInput): Promise<State> {
  assertNetworkEnabled();
  const fp = await buildFingerprint();
  const timeZone = detectTimeZone();
  const previous = await loadState();
  const previousToken = previous && previous.linked !== true && previous.token && previous.token !== input.token ? previous.token : null;
  const body: ActivateRequest = {
    token: input.token,
    ...(input.email ? { email: input.email } : {}),
    pluginVersion: PLUGIN_VERSION,
    timeZone,
    ...(previousToken ? { previousToken } : {}),
    ...internalMarker(),
    ...fp
  };
  const res = await withRetry(
    () =>
      fetchSigned("POST", "/api/v1/license/activate", body, {
        baseUrl: input.baseUrl,
        bearer: input.token,
        fingerprint: fp.fingerprint,
        installId: fp.installId,
        timeoutMs: 10_000
      }),
    { attempts: 3 }
  );
  if (!res.ok) {
    if (res.status >= 500) {
      throw new Error("Tokmizer servers are temporarily unreachable. Try again in a minute.");
    }
    const text = await res.text();
    if (errorCode(text) === "device_cap") {
      throw new Error(M.deviceCap);
    }
    throw new Error(M.failed(`${res.status} ${text}`));
  }
  const parsed = await consumeSignedJson<ActivateResponse>(res);
  const state: State = {
    token: input.token,
    jwt: parsed.jwt,
    signingSecret: parsed.signingSecret,
    plan: parsed.plan,
    status: parsed.status,
    trialEndsAt: parsed.trialEndsAt,
    subEndsAt: parsed.subEndsAt,
    jwtVersion: parsed.jwtVersion,
    installId: fp.installId,
    fingerprint: fp.fingerprint,
    pluginVersion: PLUGIN_VERSION,
    ...(input.email || parsed.boundEmail ? { email: input.email ?? parsed.boundEmail ?? "" } : {}),
    timeZone,
    bonusActive: false,
    linked: true,
    lastHeartbeatOkAt: Date.now(),
    ...(Array.isArray(parsed.allowedFilters) && parsed.allowedFilters.length > 0
      ? { allowedFilters: parsed.allowedFilters.map(slugKey) }
      : {})
  };
  await saveState(state);
  await reloadDaemon();
  await refreshBundles(input.baseUrl, true);
  return state;
}

function errorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

function localDateIn(timeZone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    return fmt.format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function jwtExpired(jwt: string, skewMs = 0): boolean {
  const payload = jwt.split(".")[1];
  if (!payload) return true;
  try {
    const exp = Number((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp);
    return !Number.isFinite(exp) || exp * 1000 <= Date.now() + skewMs;
  } catch {
    return true;
  }
}

async function saveIfSameToken(cur: State, next: State): Promise<boolean> {
  const fresh = await loadState();
  if (fresh && fresh.token !== cur.token) return false;
  await saveState(next);
  return true;
}

export async function heartbeat(baseUrl: string): Promise<State | null> {
  const cur = await loadState();
  if (!cur) return null;
  if (!networkEnabled()) return cur;
  const fp = await buildFingerprint();
  const timeZone = cur.timeZone ?? detectTimeZone();
  const health = await collectHealth();
  const body: HeartbeatRequest = {
    ts: Date.now(),
    localDate: localDateIn(timeZone),
    timeZone,
    ...(health ? { health } : {})
  };
  let res: Response;
  try {
    res = await fetchSigned(
      "POST",
      "/api/v1/license/heartbeat",
      body,
      {
        baseUrl,
        bearer: cur.jwt,
        signingSecret: cur.signingSecret,
        fingerprint: fp.fingerprint,
        installId: fp.installId,
        timeoutMs: 5000
      }
    );
  } catch {
    return cur;
  }

  if (res.status === 401) {
    const fails = (cur.heartbeatAuthFails ?? 0) + 1;
    const next: State = { ...cur, heartbeatAuthFails: fails };
    const linked = cur.linked ?? (!!cur.email || cur.plan === "smart" || cur.plan === "pro");
    if (fails >= AUTH_FAIL_HEAL_THRESHOLD && linked) next.relinkRequired = true;
    if (!(await saveIfSameToken(cur, next))) return null;
    if (fails >= AUTH_FAIL_HEAL_THRESHOLD && !linked) {
      try {
        await writeFile(
          `${tokmizerHome()}/state.replaced.json`,
          JSON.stringify(cur),
          { mode: 0o600 }
        );
      } catch {}
      try {
        return await autoEnroll(baseUrl);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (res.status === 451) {
    const fresh = await loadState();
    if (fresh && fresh.token !== cur.token) return null;
    await clearState();
    try {
      await pruneSkills([]);
      await pruneCommands([]);
    } catch {}
    return null;
  }
  if (res.status === 426) {
    await saveIfSameToken(cur, { ...cur, updateRequired: true });
    return null;
  }
  if (res.status === 423) {
    await saveIfSameToken(cur, { ...cur, relinkRequired: true });
    return null;
  }
  if (!res.ok) {
    if (res.status === 400) {
      try {
        const body = (await res.json()) as { code?: string } | null;
        if (body?.code === "stale_ts") await saveIfSameToken(cur, { ...cur, clockSkewDetected: true });
      } catch {}
    }
    return cur;
  }

  let hb: HeartbeatResponse;
  try {
    hb = await consumeSignedJson<HeartbeatResponse>(res);
  } catch {
    return cur;
  }
  setFailOpen(hb.failOpen === true);
  if (health) clearShimFallbacks();
  const serverRev = hb.settingsRevision ?? 0;
  const knownRev = cur.lastSettingsRevision ?? 0;
  const revisionAdvanced = serverRev > knownRev;
  const planChanged = hb.plan !== cur.plan;

  const next: State = {
    ...cur,
    jwt: hb.jwt,
    plan: hb.plan,
    status: hb.status,
    trialEndsAt: hb.trialEndsAt,
    subEndsAt: hb.subEndsAt,
    jwtVersion: hb.jwtVersion,
    lastSettingsRevision: knownRev,
    lastHeartbeatOkAt: Date.now(),
    heartbeatAuthFails: 0,
    relinkRequired: false,
    updateRequired: false,
    clockSkewDetected: false,
    timeZone,
    bonusActive: hb.bonusActive ?? false,
    ...(hb.bonusResetAt !== undefined ? { bonusResetAt: hb.bonusResetAt } : {}),
    ...(hb.latestPluginVersion ? { latestPluginVersion: hb.latestPluginVersion } : {}),
    ...(Array.isArray(hb.allowedFilters) ? { allowedFilters: hb.allowedFilters.map(slugKey) } : {})
  };
  if (revisionAdvanced) {
    try {
      await getSettings();
      next.lastSettingsRevision = serverRev;
    } catch {}
  }
  if (!(await saveIfSameToken(cur, next))) return loadState();
  if (process.env.TOKMIZER_SELF_UPDATE_CHILD !== "1") {
    try {
      const { maybeSpawnSelfUpdate } = await import("./self-update");
      maybeSpawnSelfUpdate();
    } catch {}
  }

  if (revisionAdvanced || planChanged) {
    await reloadDaemon();
  }
  await refreshBundles(baseUrl, revisionAdvanced || planChanged);
  try {
    const { syncReducerRules } = await import("./agent-bonuses");
    await syncReducerRules();
  } catch {}
  try {
    const { flushTelemetry } = await import("./learn/telemetry");
    const { flush } = await import("./learn/recorder");
    await flushTelemetry(baseUrl);
    await flush(baseUrl);
  } catch {}
  return next;
}

export { baseUrlFromEnv };

const ENROLL_COOLDOWN_MS = 5 * 60_000;

export async function autoEnroll(baseUrl: string): Promise<State> {
  assertNetworkEnabled();
  const fp = await buildFingerprint();
  const timeZone = detectTimeZone();
  const body: EnrollRequest = { pluginVersion: PLUGIN_VERSION, timeZone, ...internalMarker(), ...fp };
  const res = await fetchSigned("POST", "/api/v1/license/enroll", body, {
    baseUrl,
    fingerprint: fp.fingerprint,
    installId: fp.installId,
    timeoutMs: 4000
  });
  if (!res.ok) throw new Error(`enroll failed ${res.status}`);
  const parsed = await consumeSignedJson<EnrollResponse>(res);
  const state: State = {
    token: parsed.token,
    jwt: parsed.jwt,
    signingSecret: parsed.signingSecret,
    plan: parsed.plan,
    status: parsed.status,
    trialEndsAt: parsed.trialEndsAt,
    subEndsAt: parsed.subEndsAt,
    jwtVersion: parsed.jwtVersion,
    installId: fp.installId,
    fingerprint: fp.fingerprint,
    pluginVersion: PLUGIN_VERSION,
    email: "",
    timeZone,
    bonusActive: false,
    linked: false,
    lastHeartbeatOkAt: Date.now(),
    ...(Array.isArray(parsed.allowedFilters) && parsed.allowedFilters.length > 0
      ? { allowedFilters: parsed.allowedFilters.map(slugKey) }
      : {})
  };
  await saveState(state);
  await reloadDaemon();
  await refreshBundles(baseUrl, true);
  return state;
}

function inCiEnvironment(): boolean {
  const ci = process.env.CI;
  if (ci && ci !== "false" && ci !== "0") return true;
  return Boolean(process.env.GITHUB_ACTIONS);
}

export async function maybeAutoEnroll(baseUrl?: string): Promise<State | null> {
  const existing = await loadState();
  if (existing) return existing;
  if (inCiEnvironment() || !networkEnabled()) return null;
  const cooldownPath = enrollCooldownFile();
  try {
    const raw = await readFile(cooldownPath, "utf8");
    const last = Number(raw);
    if (Number.isFinite(last) && Date.now() - last < ENROLL_COOLDOWN_MS) return null;
  } catch {}
  try {
    return await autoEnroll(baseUrl ?? baseUrlFromEnv());
  } catch {
    await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
    await writeFile(cooldownPath, String(Date.now()), { mode: 0o600 });
    return null;
  }
}
