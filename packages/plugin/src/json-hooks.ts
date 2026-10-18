import { existsSync, readFileSync } from "node:fs";
import { isJsonObject, isTokmizerHookCommand, keepFirstHook, readJsonConfig, writeJsonConfig, type HookInstall, type HookRemoval, type JsonObject } from "./hook-config";

export type JsonHookSpec = {
  mark: string;
  event: string;
  nested: boolean;
  path?: readonly string[];
  matcher?: string;
  entry: (command: string) => JsonObject;
  prepare?: (parsed: JsonObject) => boolean;
};

type Ensured = Exclude<HookInstall, "error">;

function isOurs(hook: unknown, mark: string): hook is JsonObject {
  return isJsonObject(hook) && isTokmizerHookCommand(hook.command, mark);
}

function boxPath(spec: JsonHookSpec): readonly string[] {
  return spec.path ?? (spec.nested ? ["hooks"] : []);
}

function container(parsed: JsonObject, spec: JsonHookSpec): JsonObject {
  let box = parsed;
  for (const key of boxPath(spec)) {
    if (!isJsonObject(box[key])) box[key] = {};
    box = box[key] as JsonObject;
  }
  return box;
}

function entries(parsed: JsonObject, spec: JsonHookSpec): unknown[] {
  let box: unknown = parsed;
  for (const key of boxPath(spec)) box = isJsonObject(box) ? box[key] : undefined;
  if (!isJsonObject(box)) return [];
  const list = box[spec.event];
  return Array.isArray(list) ? list : [];
}

function groupHooks(group: unknown): unknown[] {
  return isJsonObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
}

function ourHooks(list: unknown[], spec: JsonHookSpec): JsonObject[] {
  const flat = spec.matcher === undefined ? list : list.flatMap(groupHooks);
  return flat.filter((h): h is JsonObject => isOurs(h, spec.mark));
}

export function jsonHookPresent(parsed: JsonObject, spec: JsonHookSpec): boolean {
  return ourHooks(entries(parsed, spec), spec).length > 0;
}

export function jsonHookInstalledIn(file: string, spec: JsonHookSpec): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isJsonObject(parsed) && jsonHookPresent(parsed, spec);
  } catch {
    return false;
  }
}

export function upsertJsonHook(parsed: JsonObject, spec: JsonHookSpec, command: string): Ensured {
  const box = container(parsed, spec);
  const list = Array.isArray(box[spec.event]) ? (box[spec.event] as unknown[]) : [];
  box[spec.event] = list;
  const existing = ourHooks(list, spec)[0];
  const entry = spec.entry(command);
  if (existing) {
    const collapsed = keepFirstHook(list, (h) => isOurs(h, spec.mark), existing, spec.matcher !== undefined);
    const stale = Object.entries(entry).filter(([k, v]) => JSON.stringify(existing[k]) !== JSON.stringify(v));
    if (!stale.length && !collapsed) return "present";
    for (const [k, v] of stale) existing[k] = v;
    return "updated";
  }
  list.push(spec.matcher === undefined ? entry : { matcher: spec.matcher, hooks: [entry] });
  return "added";
}

export function stripJsonHook(parsed: JsonObject, spec: JsonHookSpec): boolean {
  if (!jsonHookPresent(parsed, spec)) return false;
  const box = container(parsed, spec);
  const list = entries(parsed, spec);
  const kept =
    spec.matcher === undefined
      ? list.filter((h) => !isOurs(h, spec.mark))
      : list
          .map((g) => (isJsonObject(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h, spec.mark)) } : g))
          .filter((g) => !isJsonObject(g) || !Array.isArray(g.hooks) || g.hooks.length > 0);
  if (kept.length) box[spec.event] = kept;
  else delete box[spec.event];
  return true;
}

export async function ensureJsonHookIn(file: string, spec: JsonHookSpec, command: string): Promise<HookInstall> {
  const parsed = await readJsonConfig(file);
  if (!parsed) return "error";
  if (spec.prepare && !spec.prepare(parsed)) return "error";
  const status = upsertJsonHook(parsed, spec, command);
  if (status === "present") return status;
  return (await writeJsonConfig(file, parsed)) ? status : "error";
}

export async function removeJsonHookFrom(file: string, spec: JsonHookSpec): Promise<HookRemoval> {
  if (!existsSync(file)) return "absent";
  const parsed = await readJsonConfig(file);
  if (!parsed) return "error";
  if (!stripJsonHook(parsed, spec)) return "absent";
  return (await writeJsonConfig(file, parsed)) ? "removed" : "error";
}
