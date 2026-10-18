import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

function resolveVersion(): string {
  const built = process.env.TOKMIZER_BUILD_VERSION;
  if (built) return built;
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const v = req(rel).version;
      if (typeof v === "string" && v) return v;
    } catch {}
  }
  return "0.0.0";
}

export const PLUGIN_VERSION = resolveVersion();

export function isOlderVersion(current: string, latest: string | undefined): boolean {
  if (!current || !latest) return false;
  const a = current.split(".").map((n) => parseInt(n, 10));
  const b = latest.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}
