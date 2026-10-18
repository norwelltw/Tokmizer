import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { tokmizerHome } from "./paths";
import { resolveConfigPath, writeTextPreserving } from "./hook-config";

export const LEGACY_BACKUP_SUFFIX = ".tkr-bak";

export function configBackupDir(): string {
  return join(tokmizerHome(), "backup", "config");
}

export function configBackupFile(file: string): string {
  const real = resolveConfigPath(file);
  const id = createHash("sha256").update(real).digest("hex").slice(0, 16);
  const name = basename(real).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return join(configBackupDir(), `${id}-${name}`);
}

function writtenMarkFile(file: string): string {
  return `${configBackupFile(file)}.written`;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function writePrivate(target: string, text: string): Promise<boolean> {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await mkdir(configBackupDir(), { recursive: true, mode: 0o700 });
    await writeFile(tmp, text, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
    return true;
  } catch {
    await unlink(tmp).catch(() => {});
    return false;
  }
}

async function adoptLegacyBackup(file: string, target: string): Promise<boolean> {
  const legacy = `${file}${LEGACY_BACKUP_SUFFIX}`;
  try {
    if (!(await lstat(legacy)).isFile()) return false;
  } catch {
    return false;
  }
  const adopted = !(await exists(target));
  if (adopted && !(await writePrivate(target, await readFile(legacy, "utf8")))) throw new Error("backup");
  await unlink(legacy).catch(() => {});
  return adopted;
}

async function writtenByTokmizer(file: string, text: string): Promise<boolean> {
  try {
    return (await readFile(writtenMarkFile(file), "utf8")).trim() === digest(text);
  } catch {
    return false;
  }
}

export async function backupConfig(file: string, content?: string): Promise<boolean> {
  let text = content;
  try {
    if (text === undefined) text = await readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    if (await adoptLegacyBackup(file, configBackupFile(file))) return true;
  } catch {
    return false;
  }
  if (await writtenByTokmizer(file, text)) return true;
  return writePrivate(configBackupFile(file), text);
}

export async function writeConfigText(file: string, text: string, current?: string): Promise<boolean> {
  if (!(await backupConfig(file, current))) return false;
  if (!(await writeTextPreserving(file, text))) return false;
  await writePrivate(writtenMarkFile(file), `${digest(text)}\n`);
  return true;
}

export async function cleanLegacyBackups(files: readonly string[]): Promise<void> {
  for (const file of new Set(files)) {
    const legacy = `${file}${LEGACY_BACKUP_SUFFIX}`;
    try {
      if ((await lstat(legacy)).isFile()) await unlink(legacy);
    } catch {}
  }
}

export async function removeConfigBackups(): Promise<void> {
  await rm(configBackupDir(), { recursive: true, force: true }).catch(() => {});
}
