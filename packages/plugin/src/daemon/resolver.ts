import type { Plan } from "../contracts";
import { connectDaemon, type DaemonClient } from "./client";
import { setFilterResolver } from "../engine";
import type { LoadedFilter } from "../engine/loader";
import type { FilterDef } from "../engine/schema";
import { slugKey } from "../contracts";
import { runtimeFromCache, type DaemonRuntime } from "./runtime";
import { defaultRulesRuntime, resolveAllowedFilters } from "../default-rules";

let cachedClient: DaemonClient | null = null;
let cachedClientPromise: Promise<DaemonClient | null> | null = null;

async function getClient(): Promise<DaemonClient | null> {
  if (cachedClient) return cachedClient;
  if (cachedClientPromise) return cachedClientPromise;
  const p: Promise<DaemonClient | null> = connectDaemon()
    .then((c) => {
      if (cachedClientPromise === p) {
        cachedClient = c;
        return c;
      }
      try {
        c.close();
      } catch {}
      return null;
    })
    .catch(() => null);
  cachedClientPromise = p;
  return p;
}

let fallbackRuntime: DaemonRuntime | null = null;
let fallbackTried = false;

async function cachedFallback(): Promise<DaemonRuntime | null> {
  if (!fallbackTried) {
    fallbackTried = true;
    fallbackRuntime = (await runtimeFromCache()) ?? defaultRulesRuntime();
  }
  return fallbackRuntime;
}

async function selectFromCache(
  cmd: string,
  wirePlan: "trial" | "smart" | "pro",
  gate: Set<string> | null
): Promise<LoadedFilter | null> {
  const rt = await cachedFallback();
  if (!rt) return null;
  const def = rt.selectFor(cmd, wirePlan, gate ? [...gate] : undefined);
  if (!def) return null;
  if (gate && !gate.has(slugKey(def.slug))) return null;
  return def;
}

function hydrate(def: FilterDef | null): LoadedFilter | null {
  if (!def) return null;
  return { ...def, matchRegex: new RegExp(def.match_command) };
}

export function installDaemonResolver(plan: Plan): void {
  setFilterResolver(async (cmd, allowed) => {
    const wirePlan: "trial" | "smart" | "pro" = plan === "free" ? "trial" : plan;
    const gate = allowed ?? resolveAllowedFilters(undefined);
    const client = await getClient();
    if (!client) return selectFromCache(cmd, wirePlan, gate);
    try {
      const def = await client.filter(cmd, wirePlan, gate ? [...gate] : undefined);
      if (!def) return null;
      if (gate && !gate.has(slugKey(def.slug))) return null;
      return hydrate(def);
    } catch {
      return selectFromCache(cmd, wirePlan, gate);
    }
  });
}

export function closeDaemonResolver(): void {
  setFilterResolver(null);
  if (cachedClient) {
    try {
      cachedClient.close();
    } catch {}
  }
  cachedClient = null;
  cachedClientPromise = null;
  fallbackRuntime = null;
  fallbackTried = false;
}
