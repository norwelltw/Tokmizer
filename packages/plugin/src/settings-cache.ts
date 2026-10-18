import { readFile, writeFile, mkdir, chmod, rm, rename, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Settings } from "./contracts";
import type { Settings as SettingsT } from "./contracts";
import { tokmizerHome } from "./paths";

const FILE = "settings-cache.json";

const DEFAULTS: SettingsT = Settings.parse({});
const SettingsPatch = Settings.partial().extend({
  filters: Settings.shape.filters.removeDefault().partial().optional()
});

export async function loadSettingsCache(): Promise<SettingsT> {
  let stored: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(tokmizerHome(), FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {}
  return stored ? Settings.parse({ ...DEFAULTS, ...stored }) : DEFAULTS;
}

export async function saveSettingsCache(s: SettingsT): Promise<void> {
  await mkdir(tokmizerHome(), { recursive: true });
  const path = join(tokmizerHome(), FILE);
  const tmpPath = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  await writeFile(tmpPath, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, path);
  } catch (err) {
    try {
      await rm(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

async function settingsTickets(dir: string): Promise<Array<{ id: string; ticket: number }>> {
  const entries = [];
  for (const id of await readdir(dir)) {
    const match = /^([1-9]\d*)-[0-9a-f-]{36}\.json$/.exec(id);
    if (!match) continue;
    const path = join(dir, id);
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        await rm(path, { force: true });
        continue;
      }
      if (code !== "EPERM") throw error;
    }
    try {
      const ticket = JSON.parse(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(ticket) || ticket < 0) throw new Error("Invalid local settings lock");
      entries.push({ id, ticket: ticket as number });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return entries;
}

export async function updateSettingsCache(input: unknown): Promise<SettingsT> {
  const patch = SettingsPatch.parse(input);
  const dir = join(tokmizerHome(), "settings-cache-locks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${randomUUID()}.json`;
  const path = join(dir, id);
  const tmp = `${path}.tmp`;
  const deadline = performance.now() + 3000;
  const publish = async (ticket: number) => {
    await writeFile(tmp, String(ticket), { mode: 0o600 });
    while (true) {
      try {
        await rename(tmp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || performance.now() >= deadline) throw error;
        await delay(10);
      }
    }
  };
  try {
    await publish(0);
    const ticket = Math.max(0, ...(await settingsTickets(dir)).map((entry) => entry.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error("Invalid local settings lock");
    await publish(ticket);
    while (true) {
      const waiting = (await settingsTickets(dir)).some((entry) => entry.id !== id &&
        (entry.ticket === 0 || entry.ticket < ticket || (entry.ticket === ticket && entry.id < id)));
      if (!waiting) {
        const current = await loadSettingsCache();
        const settings = Settings.parse({ ...current, ...patch, filters: { ...current.filters, ...patch.filters } });
        await saveSettingsCache(settings);
        return settings;
      }
      if (performance.now() >= deadline) throw new Error("Timed out waiting for local settings lock after 3 seconds; another process may still be updating settings");
      await delay(10);
    }
  } finally {
    await Promise.all([rm(path, { force: true }), rm(tmp, { force: true })]);
  }
}

export async function clearSettingsCache(): Promise<void> {
  try {
    await rm(join(tokmizerHome(), FILE), { force: true });
  } catch {}
}
