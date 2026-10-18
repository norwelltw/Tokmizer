import { readFileSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { tokmizerHome } from "../paths";
import { scanSqliteTable } from "./sqlite-read";

export type RtkHistoryTotals = {
  source: string;
  commands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  firstAt: string | null;
  lastAt: string | null;
  importedAt: string;
};

const MAX_DB_BYTES = 512 * 1024 * 1024;

export function rtkImportFile(): string {
  return join(tokmizerHome(), "rtk-import.json");
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "bigint" ? Number(value) : 0;
}

export function readRtkHistory(file: string, now: Date = new Date()): { totals: RtkHistoryTotals } | { error: string } {
  try {
    if (statSync(file).size > MAX_DB_BYTES) return { error: "the history file is too large to read" };
  } catch {
    return { error: "no history file" };
  }
  try {
    const totals: RtkHistoryTotals = { source: file, commands: 0, inputTokens: 0, outputTokens: 0, savedTokens: 0, firstAt: null, lastAt: null, importedAt: now.toISOString() };
    scanSqliteTable(readFileSync(file), "commands", (row) => {
      totals.commands += 1;
      totals.inputTokens += num(row.input_tokens);
      totals.outputTokens += num(row.output_tokens);
      totals.savedTokens += num(row.saved_tokens);
      const at = typeof row.timestamp === "string" ? row.timestamp : null;
      if (at && (!totals.firstAt || at < totals.firstAt)) totals.firstAt = at;
      if (at && (!totals.lastAt || at > totals.lastAt)) totals.lastAt = at;
    });
    return { totals };
  } catch (err) {
    return { error: `could not read it (${(err as Error).message})` };
  }
}

export async function loadRtkImport(): Promise<RtkHistoryTotals | null> {
  try {
    const parsed = JSON.parse(await readFile(rtkImportFile(), "utf8")) as Partial<RtkHistoryTotals>;
    if (typeof parsed.commands !== "number" || typeof parsed.savedTokens !== "number") return null;
    return parsed as RtkHistoryTotals;
  } catch {
    return null;
  }
}

export async function saveRtkImport(totals: RtkHistoryTotals): Promise<void> {
  await mkdir(tokmizerHome(), { recursive: true, mode: 0o700 });
  const tmp = `${rtkImportFile()}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(totals, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, rtkImportFile());
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function renderRtkImportLine(t: RtkHistoryTotals): string {
  const span = t.firstAt && t.lastAt ? `, ${t.firstAt.slice(0, 10)} to ${t.lastAt.slice(0, 10)}` : "";
  return `  Imported from rtk: ${compact(t.savedTokens)} tokens saved over ${t.commands} command${t.commands === 1 ? "" : "s"}${span} (rtk's own estimate, not included above)\n`;
}
