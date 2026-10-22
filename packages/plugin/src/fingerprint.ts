import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tokmizerHome, installIdFile } from "./paths";

export type FingerprintSignals = {
  fingerprint: string;
  installId: string;
};

export async function ensureInstallId(): Promise<string> {
  try {
    const raw = await readFile(installIdFile(), "utf8");
    const trimmed = raw.trim();
    if (/^[0-9a-f-]{36}$/i.test(trimmed)) return trimmed;
  } catch {}
  await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
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

export async function buildFingerprint(): Promise<FingerprintSignals> {
  const installId = await ensureInstallId();
  return {
    fingerprint: createHash("sha256").update(installId).digest("hex"),
    installId
  };
}
