import { readFileSync } from "node:fs";
import { parseUserFilterText } from "../engine/user-filters";
import { rtkConfigFile, type RtkEnv } from "./rtk-paths";

export type RtkConfigImport = {
  file: string | null;
  parseError: string | null;
  excludePatterns: string[];
  excludeText: string | null;
  excludeSkipped: { name: string; reason: string }[];
  retentionDays: number | null;
  restoreDisabled: boolean;
  telemetryOff: boolean;
  historyPath: string | null;
  notImported: string[];
};

const RTK_DEFAULT_RETENTION_DAYS = 30;
const TOKMIZER_DEFAULT_RETENTION_DAYS = 30;

function table(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function excludeRegex(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === "^") return null;
  return trimmed.startsWith("^") ? trimmed : `^${escapeRegex(trimmed)}($|\\s)`;
}

const IMPORTED_KEYS = new Set([
  "hooks.exclude_commands",
  "retriever.mode",
  "retriever.retention_days",
  "tee.enabled",
  "telemetry.enabled",
  "telemetry.consent_given",
  "telemetry.consent_date",
  "tracking.database_path"
]);

export async function readRtkConfig(e: RtkEnv): Promise<RtkConfigImport> {
  const result: RtkConfigImport = {
    file: rtkConfigFile(e),
    parseError: null,
    excludePatterns: [],
    excludeText: null,
    excludeSkipped: [],
    retentionDays: null,
    restoreDisabled: false,
    telemetryOff: false,
    historyPath: null,
    notImported: []
  };
  if (!result.file) return result;
  const { parse, stringify } = await import("smol-toml");
  let doc: Record<string, unknown>;
  try {
    doc = parse(readFileSync(result.file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
  } catch (err) {
    result.parseError = String((err as Error).message).split("\n")[0] ?? "unreadable";
    return result;
  }
  for (const [section, body] of Object.entries(doc)) {
    const t = table(body);
    if (Object.keys(t).length === 0 && (typeof body !== "object" || body === null)) {
      result.notImported.push(section);
      continue;
    }
    for (const key of Object.keys(t)) {
      if (!IMPORTED_KEYS.has(`${section}.${key}`)) result.notImported.push(`${section}.${key}`);
    }
  }
  const hooks = table(doc.hooks);
  const retriever = table(doc.retriever);
  const tee = table(doc.tee);
  const telemetry = table(doc.telemetry);
  const tracking = table(doc.tracking);

  if (Array.isArray(hooks.exclude_commands)) {
    result.excludePatterns = hooks.exclude_commands.filter((p): p is string => typeof p === "string");
    const filters: Record<string, Record<string, unknown>> = {};
    let n = 0;
    for (const pattern of result.excludePatterns) {
      const regex = excludeRegex(pattern);
      if (!regex) {
        result.excludeSkipped.push({ name: pattern, reason: "empty pattern, rtk ignores it too" });
        continue;
      }
      n += 1;
      const name = `rtk-exclude-${n}`;
      const rule = { description: `Left unchanged, as rtk exclude_commands "${pattern}"`.slice(0, 255), match_command: regex, preserve_exact: true, priority: 100 };
      const check = await parseUserFilterText(stringify({ schema_version: 1, filters: { [name]: rule } }), "rtk-excluded.toml");
      if (check.issues.length > 0) {
        result.excludeSkipped.push({ name: pattern, reason: "not a regular expression Tokmizer can read" });
        n -= 1;
        continue;
      }
      filters[name] = rule;
    }
    if (Object.keys(filters).length > 0) result.excludeText = stringify({ schema_version: 1, filters });
  }

  const hasRetriever = Object.keys(retriever).length > 0;
  if (retriever.mode === "disabled" || (!hasRetriever && tee.enabled === false)) result.restoreDisabled = true;
  const days = retriever.retention_days;
  if (typeof days === "number" && Number.isInteger(days) && days > 0 && days !== RTK_DEFAULT_RETENTION_DAYS && days !== TOKMIZER_DEFAULT_RETENTION_DAYS) {
    result.retentionDays = Math.min(days, 365);
  }
  result.telemetryOff = telemetry.enabled === false || telemetry.consent_given === false;
  if (typeof tracking.database_path === "string" && tracking.database_path) result.historyPath = tracking.database_path;
  return result;
}
