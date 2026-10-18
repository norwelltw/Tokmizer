import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tokmizerHome, installIdFile } from "./paths";

export type FingerprintSignals = {
  fingerprint: string;
  installId: string;
  hostname: string;
  os: string;
  osVersion: string;
  cpuModel: string;
  cpuCores: number;
  macHash: string;
  usernameHash: string;
};

export async function ensureInstallId(): Promise<string> {
  try {
    const raw = await readFile(installIdFile(), "utf8");
    const trimmed = raw.trim();
    if (/^[0-9a-f-]{36}$/i.test(trimmed)) return trimmed;
  } catch {}
  await mkdir(tokmizerHome(), { recursive: true });
  const id = randomUUID();
  try {
    await writeFile(installIdFile(), id, { mode: 0o600, flag: "wx" });
    return id;
  } catch {
    try {
      const raw = (await readFile(installIdFile(), "utf8")).trim();
      if (/^[0-9a-f-]{36}$/i.test(raw)) return raw;
    } catch {}
    await writeFile(installIdFile(), id, { mode: 0o600 });
    return id;
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function primaryMac(): string {
  const nets = os.networkInterfaces();
  for (const key of Object.keys(nets)) {
    for (const iface of nets[key] ?? []) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
        return iface.mac;
      }
    }
  }
  return "no-mac";
}

export async function buildFingerprint(): Promise<FingerprintSignals> {
  const installId = await ensureInstallId();
  const hostname = os.hostname();
  const platform = os.platform();
  const osVersion = os.release();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "unknown";
  const cpuCores = cpus.length;
  const macHash = sha256Hex(primaryMac());
  const usernameHash = sha256Hex(os.userInfo().username);
  const composite = [
    hostname,
    platform,
    osVersion,
    cpuModel,
    String(cpuCores),
    macHash,
    usernameHash,
    installId
  ].join("|");
  return {
    fingerprint: sha256Hex(composite),
    installId,
    hostname,
    os: platform,
    osVersion,
    cpuModel,
    cpuCores,
    macHash,
    usernameHash
  };
}
