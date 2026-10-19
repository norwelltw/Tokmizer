import { chmodSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tokmizerHome } from "../paths";

const CachedEnvelope = z.object({
  payload: z.string().min(1),
  signature: z.string().min(1),
  enc: z.literal("v1"),
  fetchedAt: z.number().int().nonnegative()
});

export type CachedEnvelope = z.infer<typeof CachedEnvelope>;

export function bundleCachePath(): string {
  return join(tokmizerHome(), "bundle-cache.json");
}

export function saveBundleCache(envelope: { payload: string; signature: string; enc: "v1" }): void {
  try {
    const home = tokmizerHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const record: CachedEnvelope = { ...envelope, fetchedAt: Date.now() };
    const tmp = join(home, `bundle-cache.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, bundleCachePath());
    chmodSync(bundleCachePath(), 0o600);
  } catch {}
}

export function loadBundleCache(): CachedEnvelope | null {
  try {
    const raw = readFileSync(bundleCachePath(), "utf8");
    const parsed = CachedEnvelope.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
