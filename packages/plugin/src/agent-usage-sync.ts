import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAgentUsage, type UsageRow } from "./agent-usage";
import { baseUrlFromEnv } from "./base-url";
import { buildFingerprint } from "./fingerprint";
import { estimateCostUsd } from "./model-prices";
import { networkEnabled } from "./network";
import { tokmizerHome } from "./paths";
import { selfInvocation, singleBinary } from "./self-command";
import { loadSettingsCache } from "./settings-cache";
import { loadState, type State } from "./state";
import { telemetryNoticeShown } from "./telemetry-hint";
import { fetchSigned } from "./transport";

const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const SYNC_DAYS = 90;
const CHUNK = 500;

export type SyncResult = "ok" | "off" | "fail";

function stampFile(): string {
  return join(tokmizerHome(), "agent-usage-sync.stamp");
}

function isLinked(s: State): boolean {
  return s.linked ?? (!!s.email || s.plan === "smart" || s.plan === "pro");
}

async function allowed(): Promise<State | null> {
  if (!networkEnabled() || !telemetryNoticeShown()) return null;
  if (!(await loadSettingsCache()).telemetryOptIn) return null;
  const state = await loadState();
  return state && isLinked(state) ? state : null;
}

function sinceMs(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (SYNC_DAYS - 1)).getTime();
}

export function shareableModel(model: string): string {
  if (model.toLowerCase().startsWith("arn:")) return "other";
  const last = model.slice(model.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(last) ? last : "other";
}

export function syncPayloadRows(rows: UsageRow[], fromMs = sinceMs()): Array<Record<string, unknown>> {
  const d = new Date(fromMs);
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return rows
    .filter((r) => r.day >= from)
    .map((r) => {
      const cost = estimateCostUsd(r.model, r);
      return {
        date: r.day,
        agent: r.agent,
        model: shareableModel(r.model),
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheWrite: r.cacheWrite + r.cacheWrite1h,
        requests: r.requests,
        costUsd: cost === null ? null : Math.round(cost * 10000) / 10000
      };
    });
}

export async function uploadAgentUsage(rows: UsageRow[], opts: { baseUrl?: string; timeoutMs?: number } = {}): Promise<SyncResult> {
  const state = await allowed();
  if (!state) return "off";
  const payload = syncPayloadRows(rows);
  if (payload.length === 0) return "ok";
  try {
    const fp = await buildFingerprint();
    for (let i = 0; i < payload.length; i += CHUNK) {
      const res = await fetchSigned("POST", "/api/v1/telemetry/agents", { rows: payload.slice(i, i + CHUNK) }, {
        baseUrl: opts.baseUrl ?? baseUrlFromEnv(),
        bearer: state.jwt,
        signingSecret: state.signingSecret,
        fingerprint: fp.fingerprint,
        installId: fp.installId,
        timeoutMs: opts.timeoutMs ?? 10_000
      });
      if (!res.ok) return "fail";
    }
  } catch {
    return "fail";
  }
  try {
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    writeFileSync(stampFile(), "", { mode: 0o600 });
  } catch {
    return "ok";
  }
  return "ok";
}

export async function runAgentUsageSync(): Promise<SyncResult> {
  if (!(await allowed())) return "off";
  try {
    os.setPriority(19);
  } catch {
    void 0;
  }
  return uploadAgentUsage(scanAgentUsage({ sinceMs: sinceMs() }));
}

function claimSlot(now = Date.now()): boolean {
  const file = stampFile();
  try {
    if (existsSync(file) && now - statSync(file).mtimeMs < SYNC_EVERY_MS) return false;
    mkdirSync(tokmizerHome(), { recursive: true, mode: 0o700 });
    if (existsSync(file)) utimesSync(file, new Date(now), new Date(now));
    else writeFileSync(file, "", { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function distRoot(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const candidate of [here, join(here, "..")]) if (existsSync(join(candidate, "bin", "tkr.js"))) return candidate;
  return null;
}

export async function maybeSpawnAgentUsageSync(): Promise<void> {
  try {
    if (process.env.TOKMIZER_USAGE_SYNC_CHILD === "1") return;
    if (!(await allowed())) return;
    const root = singleBinary() ? "" : distRoot();
    if (root === null) return;
    if (!claimSlot()) return;
    const [command, ...args] = selfInvocation(join(root, "bin", "tkr.js"));
    const child = spawn(command!, [...args, "usage", "--sync"], {
      cwd: os.homedir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, TOKMIZER_USAGE_SYNC_CHILD: "1" }
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    return;
  }
}
