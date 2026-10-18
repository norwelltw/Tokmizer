import { join } from "node:path";
import { baseUrlFromEnv } from "../base-url";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tokmizerHome } from "../paths";
import { loadState } from "../state";
import { buildFingerprint } from "../fingerprint";
import { fetchSigned } from "../transport";
import { loadSettingsCache } from "../settings-cache";
import { networkEnabled } from "../network";
import { telemetryNoticeShown } from "../telemetry-hint";

const MAX_SPOOL_BYTES = 512 * 1024;
const UPLOAD_CHUNK = 100;
const LOCK_STALE_MS = 120_000;
const uploading = new Set<string>();

function lockDir(name: SpoolName): string {
  return join(spoolDir(), `${name}.lock`);
}

function acquireUploadLock(name: SpoolName): boolean {
  const lock = lockDir(name);
  try {
    mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    mkdirSync(lock);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lock);
      }
    } catch {
      return false;
    }
    return false;
  }
}

function touchUploadLock(name: SpoolName): void {
  try {
    utimesSync(lockDir(name), new Date(), new Date());
  } catch {
    return;
  }
}

function releaseUploadLock(name: SpoolName): void {
  try {
    rmdirSync(lockDir(name));
  } catch {
    return;
  }
}

export type SpoolName = "learn" | "telemetry";

function spoolDir(): string {
  return join(tokmizerHome(), "spool");
}

function spoolFile(name: SpoolName): string {
  return join(spoolDir(), `${name}.jsonl`);
}

function pendingFile(name: SpoolName): string {
  return join(spoolDir(), `${name}.pending.jsonl`);
}

export function appendSpool(name: SpoolName, event: unknown): void {
  if (!networkEnabled()) return;
  try {
    mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    const file = spoolFile(name);
    if (existsSync(file) && statSync(file).size >= MAX_SPOOL_BYTES) return;
    appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    return;
  }
}

function consumeMerging(pending: string, merging: string): void {
  appendFileSync(pending, readFileSync(merging, "utf8"), { mode: 0o600 });
  writeFileSync(merging, "", { mode: 0o600 });
  try {
    unlinkSync(merging);
  } catch {
    return;
  }
}

function capPending(pending: string): void {
  if (statSync(pending).size <= MAX_SPOOL_BYTES) return;
  const lines = readFileSync(pending, "utf8").split("\n").filter((l) => l.trim());
  let size = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    size += Buffer.byteLength(line, "utf8") + 1;
    if (size > MAX_SPOOL_BYTES) break;
    kept.unshift(line);
  }
  writeFileSync(pending, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
}

export function drainSpool(name: SpoolName): unknown[] {
  try {
    const pending = pendingFile(name);
    const file = spoolFile(name);
    const merging = `${file}.merging`;
    if (existsSync(merging)) {
      consumeMerging(pending, merging);
    }
    if (!existsSync(pending)) {
      if (!existsSync(file)) return [];
      renameSync(file, pending);
    } else if (existsSync(file)) {
      renameSync(file, merging);
      consumeMerging(pending, merging);
    }
    capPending(pending);
    const events: unknown[] = [];
    for (const line of readFileSync(pending, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    if (events.length === 0) {
      unlinkSync(pending);
      return [];
    }
    return events;
  } catch {
    return [];
  }
}

export function commitSpool(name: SpoolName): void {
  try {
    unlinkSync(pendingFile(name));
  } catch {
    return;
  }
}

function persistRemainder(name: SpoolName, events: unknown[]): void {
  if (events.length === 0) {
    commitSpool(name);
    return;
  }
  const pending = pendingFile(name);
  const tmp = `${pending}.tmp`;
  writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, pending);
}

export type UploadResult = "ok" | "empty" | "auth" | "fail";

export async function uploadSpool(
  name: SpoolName,
  endpoint: string,
  opts: { baseUrl?: string | undefined; requirePro?: boolean; consent?: boolean } = {}
): Promise<UploadResult> {
  if (!networkEnabled()) return "fail";
  if (uploading.has(name)) return "fail";
  if (!acquireUploadLock(name)) return "fail";
  uploading.add(name);
  try {
    if (!(await loadSettingsCache()).telemetryOptIn) {
      clearSpool(name);
      return "empty";
    }
    if (!telemetryNoticeShown()) return "fail";
    const events = drainSpool(name);
    if (events.length === 0) return "empty";
    const state = await loadState();
    if (!state) return "fail";
    if (opts.requirePro && state.plan !== "pro") {
      commitSpool(name);
      return "ok";
    }
    const url = opts.baseUrl ?? baseUrlFromEnv();
    const fp = await buildFingerprint();
    for (let i = 0; i < events.length; i += UPLOAD_CHUNK) {
      if (!(await loadSettingsCache()).telemetryOptIn) {
        clearSpool(name);
        return "empty";
      }
      touchUploadLock(name);
      const res = await fetchSigned(
        "POST",
        endpoint,
        { events: events.slice(i, i + UPLOAD_CHUNK), ...(opts.consent ? { consent: true } : {}) },
        {
          baseUrl: url,
          bearer: state.jwt,
          signingSecret: state.signingSecret,
          fingerprint: fp.fingerprint,
          installId: fp.installId
        }
      );
      if (!res.ok) return res.status === 401 || res.status === 403 ? "auth" : "fail";
      persistRemainder(name, events.slice(i + UPLOAD_CHUNK));
    }
    return "ok";
  } catch {
    return "fail";
  } finally {
    uploading.delete(name);
    releaseUploadLock(name);
  }
}

export function clearSpool(name: SpoolName): void {
  try {
    unlinkSync(spoolFile(name));
  } catch {
    void 0;
  }
  try {
    unlinkSync(`${spoolFile(name)}.merging`);
  } catch {
    void 0;
  }
  try {
    unlinkSync(pendingFile(name));
  } catch {
    return;
  }
}
