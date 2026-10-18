import { join } from "node:path";
import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import type { Plan, TokenStatus } from "./contracts";
import { tokmizerHome } from "./paths";

export type State = {
  token: string;
  jwt: string;
  signingSecret: string;
  plan: Plan;
  status: TokenStatus;
  trialEndsAt: string | null;
  subEndsAt: string | null;
  jwtVersion: number;
  installId: string;
  installedAt?: number;
  email?: string;
  fingerprint?: string;
  pluginVersion?: string;
  lastSettingsRevision?: number;
  timeZone?: string;
  bonusActive?: boolean;
  bonusResetAt?: string;
  lastHeartbeatOkAt?: number;
  latestPluginVersion?: string;
  allowedFilters?: string[];
  heartbeatAuthFails?: number;
  relinkRequired?: boolean;
  linked?: boolean;
  updateRequired?: boolean;
  clockSkewDetected?: boolean;
};

const STATE_FILE = "state.json";

export const DEFAULT_STATE: Pick<
  State,
  "lastSettingsRevision" | "timeZone" | "bonusActive" | "bonusResetAt"
> = {
  lastSettingsRevision: 0,
  get timeZone() {
    return detectTimeZone();
  },
  bonusActive: false
};

export function detectTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : "Etc/UTC";
  } catch {
    return "Etc/UTC";
  }
}

function dirFor(opts?: { dir?: string }): string {
  return opts?.dir ?? tokmizerHome();
}

export async function loadState(opts?: { dir?: string }): Promise<State | null> {
  const dir = dirFor(opts);
  try {
    const raw = await readFile(join(dir, STATE_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    let timeZone = parsed.timeZone;
    return {
      ...parsed,
      lastSettingsRevision: parsed.lastSettingsRevision ?? 0,
      get timeZone() {
        return timeZone ??= detectTimeZone();
      },
      bonusActive: parsed.bonusActive ?? false,
      ...(parsed.bonusResetAt !== undefined ? { bonusResetAt: parsed.bonusResetAt } : {})
    } as State;
  } catch {
    return null;
  }
}

export async function saveState(state: State, opts?: { dir?: string }): Promise<void> {
  const dir = dirFor(opts);
  await mkdir(dir, { recursive: true });
  if (state.installedAt == null) state.installedAt = Math.floor(Date.now() / 1000);
  const finalPath = join(dir, STATE_FILE);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {}
    throw err;
  }
}

export async function clearState(opts?: { dir?: string }): Promise<void> {
  const dir = dirFor(opts);
  try {
    await unlink(join(dir, STATE_FILE));
  } catch {
    return;
  }
}
