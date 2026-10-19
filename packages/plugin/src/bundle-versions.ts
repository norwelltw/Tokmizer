import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { bundleVersionsFile, tokmizerHome } from "./paths";

type Versioned = { slug: string; version: number };

async function readInstalledVersions(): Promise<Map<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(bundleVersionsFile(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed).filter((e): e is [string, number] => Number.isSafeInteger(e[1]))
    );
  } catch {
    return new Map();
  }
}

export async function assertNoBundleRollback(bundles: Versioned[]): Promise<void> {
  const installed = await readInstalledVersions();
  const older = bundles.filter((b) => b.version < (installed.get(b.slug) ?? -Infinity));
  if (older.length > 0) {
    throw new Error(
      `bundle rollback refused: ${older.map((b) => `${b.slug} ${b.version} < ${installed.get(b.slug)}`).join(", ")}`
    );
  }
}

export async function recordInstalledVersions(bundles: Versioned[]): Promise<void> {
  if (bundles.length === 0) return;
  try {
    const installed = await readInstalledVersions();
    for (const b of bundles) installed.set(b.slug, Math.max(installed.get(b.slug) ?? b.version, b.version));
    await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
    await writeFile(bundleVersionsFile(), JSON.stringify(Object.fromEntries(installed)), { mode: 0o600 });
    await chmod(bundleVersionsFile(), 0o600);
  } catch {}
}
