import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tokmizerHome, restoreConfigFile } from "../paths";
import { userFiltersDir, userFiltersTrustFile, trustUserFilters, __resetUserFilters } from "../engine/user-filters";
import { loadSettingsCache } from "../settings-cache";
import { patchSettings } from "../settings-client";
import { shimsDir } from "../shim/install";
import { convertRtkFilters, rtkFilterSources, type ConvertedFilters } from "./rtk-filters";
import { readRtkConfig, type RtkConfigImport } from "./rtk-config";
import { readRtkHistory, rtkImportFile, type RtkHistoryTotals } from "./rtk-history";
import { scanRtkHooks, type AgentFinding } from "./rtk-hooks";
import { findRtkBinary, rtkConfigDirs, rtkDataDir, rtkHistoryDb, type RtkBinary, type RtkEnv } from "./rtk-paths";
import { rtkShimContent, rtkShimFile } from "./rtk-compat";

export type MigrationPlan = {
  binary: RtkBinary | null;
  dirs: string[];
  filters: ConvertedFilters[];
  config: RtkConfigImport;
  history: { file: string; totals?: RtkHistoryTotals; error?: string } | null;
  hooks: AgentFinding[];
  telemetryOn: boolean;
  shim: { file: string; content: string } | null;
};

type FileRecord = { path: string; backup: string | null; after: string | null };

type Manifest = { v: 1; createdAt: string; files: FileRecord[]; telemetryWas?: boolean; undoneAt?: string };

export function migrationsDir(): string {
  return join(tokmizerHome(), "migrate-rtk");
}

function hash(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function fileHash(path: string): string | null {
  try {
    return hash(readFileSync(path));
  } catch {
    return null;
  }
}

export function rtkDetected(e: RtkEnv): { binary: RtkBinary | null; dirs: string[] } {
  const binary = findRtkBinary(e, [shimsDir()]);
  const dirs = [...new Set([...rtkConfigDirs(e).map((d) => d.dir), rtkDataDir(e)])].filter((d) => existsSync(d));
  return { binary: binary && !binary.compatShim ? binary : null, dirs };
}

export async function buildPlan(e: RtkEnv, opts: { shim?: { tkr: string[] } } = {}): Promise<MigrationPlan> {
  const { binary, dirs } = rtkDetected(e);
  const filters: ConvertedFilters[] = [];
  for (const source of rtkFilterSources(e)) {
    const converted = await convertRtkFilters(e, source);
    if (converted) filters.push(converted);
  }
  const config = await readRtkConfig(e);
  const dbFile = rtkHistoryDb(e, config.historyPath);
  const history = existsSync(dbFile) ? (() => {
    const r = readRtkHistory(dbFile);
    return "error" in r ? { file: dbFile, error: r.error } : { file: dbFile, totals: r.totals };
  })() : null;
  const settings = await loadSettingsCache().catch(() => ({ telemetryOptIn: false }));
  return {
    binary,
    dirs,
    filters,
    config,
    history,
    hooks: scanRtkHooks(e),
    telemetryOn: settings.telemetryOptIn === true,
    shim: opts.shim ? { file: rtkShimFile(shimsDir()), content: rtkShimContent(opts.shim.tkr) } : null
  };
}

type Step = { path: string; content: string | null; mode?: number; done: string };

type PendingWork = { steps: Step[]; trust: string[]; telemetry: boolean };

function plannedSteps(plan: MigrationPlan): { steps: Step[]; toTrust: string[] } {
  const steps: Step[] = [];
  const toTrust: string[] = [];
  for (const f of plan.filters) {
    if (!f.text) continue;
    const target = join(userFiltersDir(), f.source.target);
    steps.push({ path: target, content: f.text, done: `Imported ${plural(f.imported.length, "filter")} into ${target}` });
    if (f.trustedByRtk && f.source.scope === "global") toTrust.push(f.source.target);
  }
  if (plan.config.excludeText) {
    const target = join(userFiltersDir(), "rtk-excluded.toml");
    steps.push({ path: target, content: plan.config.excludeText, done: `Imported exclude_commands into ${target}` });
    toTrust.push("rtk-excluded.toml");
  }
  if (plan.config.restoreDisabled || plan.config.retentionDays) {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(restoreConfigFile(), "utf8")) as Record<string, unknown>;
    } catch {}
    const next = plan.config.restoreDisabled ? { ...current, disabled: true } : { ...current, maxAgeDays: plan.config.retentionDays };
    steps.push({
      path: restoreConfigFile(),
      content: `${JSON.stringify(next, null, 2)}\n`,
      done: plan.config.restoreDisabled ? "tkr restore disabled, as rtk recall was" : `tkr restore keeps outputs ${plan.config.retentionDays} days`
    });
  }
  if (plan.history?.totals) {
    steps.push({ path: rtkImportFile(), content: historyImportContent(plan.history.totals), done: "Imported rtk savings history (shown separately in tkr gain)" });
  }
  for (const h of plan.hooks) {
    if (!h.tkrInstalled) continue;
    for (const edit of h.edits) {
      steps.push({ path: edit.file, content: edit.action === "delete" ? null : edit.content ?? "", done: `${h.agent}: removed ${edit.what} from ${edit.file}` });
    }
  }
  if (plan.shim) steps.push({ path: plan.shim.file, content: plan.shim.content, mode: 0o755, done: `Wrote ${plan.shim.file}` });
  return { steps, toTrust };
}

function sameTotals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = (o: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== "importedAt").sort()));
  return strip(a) === strip(b);
}

function historyImportContent(totals: RtkHistoryTotals): string {
  try {
    const existing = readFileSync(rtkImportFile(), "utf8");
    if (sameTotals(JSON.parse(existing) as Record<string, unknown>, totals as unknown as Record<string, unknown>)) return existing;
  } catch {}
  return `${JSON.stringify(totals, null, 2)}\n`;
}

function stepPending(step: Step): boolean {
  if (step.content === null) return existsSync(step.path);
  try {
    return readFileSync(step.path, "utf8") !== step.content;
  } catch {
    return true;
  }
}

function trustedHashes(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(userFiltersTrustFile(), "utf8")) as { files?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(parsed.files ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function pendingWork(plan: MigrationPlan): PendingWork {
  const { steps, toTrust } = plannedSteps(plan);
  const trusted = trustedHashes();
  const content = new Map(steps.map((s) => [s.path, s.content]));
  const trust = toTrust.filter((name) => {
    const text = content.get(join(userFiltersDir(), name));
    return typeof text !== "string" || trusted[name] !== hash(text);
  });
  return { steps: steps.filter(stepPending), trust, telemetry: plan.config.telemetryOff && plan.telemetryOn };
}

export function planHasWork(plan: MigrationPlan): boolean {
  const work = pendingWork(plan);
  return work.steps.length > 0 || work.trust.length > 0 || work.telemetry;
}

export function migrationApplied(): boolean {
  return openManifests().length > 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function renderPlan(plan: MigrationPlan): string {
  const out: string[] = [];
  const found = plan.binary ? `${plan.binary.path}${plan.binary.version ? ` (${plan.binary.version})` : ""}` : "no rtk binary on PATH";
  out.push(`rtk: ${found}`);
  for (const dir of plan.dirs) out.push(`  data: ${dir}`);
  out.push("", "Filters");
  if (plan.filters.length === 0) out.push("  no rtk filters.toml found");
  for (const f of plan.filters) {
    out.push(`  ${f.source.path}${f.source.readByRtk ? "" : " (rtk does not read this folder on this system)"}`);
    if (f.fileIssue) out.push(`    not imported: ${f.fileIssue}`);
    if (f.text) {
      const target = join(userFiltersDir(), f.source.target);
      out.push(`    import ${plural(f.imported.length, "filter")} into ${target}: ${f.imported.join(", ")}`);
      out.push(f.trustedByRtk && f.source.scope === "global"
        ? "    trusted, as it was in rtk"
        : `    left untrusted${f.source.scope === "project" ? " (Tokmizer filters apply in every project)" : " (rtk had not trusted it)"}: review it, then run tkr filters trust ${f.source.target}`);
    }
    for (const s of f.skipped) out.push(`    not imported: ${s.name}: ${s.reason}`);
    for (const t of f.tests) {
      out.push(`    test ${t.pass ? "PASS" : "FAIL"} ${t.rule} #${t.index}${t.name ? ` (${t.name})` : ""}`);
      if (!t.pass) out.push(`      expected: ${JSON.stringify(t.expected.trimEnd())}`, `      got:      ${JSON.stringify(t.actual.trimEnd())}`);
    }
    const failed = f.tests.filter((t) => !t.pass).length;
    if (f.tests.length > 0) out.push(`    ${plural(f.tests.length, "test")}: ${f.tests.length - failed} pass on Tokmizer, ${failed} fail`);
    if (f.untested.length > 0) out.push(`    without tests: ${f.untested.join(", ")}`);
    if (f.orphanTests.length > 0) out.push(`    tests for unknown filters ignored: ${f.orphanTests.join(", ")}`);
  }
  out.push("", "Settings");
  const c = plan.config;
  if (!c.file) out.push("  no rtk config.toml found");
  else if (c.parseError) out.push(`  ${c.file}: not imported, not valid TOML (${c.parseError})`);
  else {
    out.push(`  ${c.file}`);
    if (c.excludeText) out.push(`    exclude_commands -> ${join(userFiltersDir(), "rtk-excluded.toml")} (output of ${c.excludePatterns.filter((p) => p.trim() && p.trim() !== "^").map((p) => JSON.stringify(p)).join(", ")} left unchanged)`);
    for (const s of c.excludeSkipped) out.push(`    exclude_commands "${s.name}" not imported: ${s.reason}`);
    if (c.restoreDisabled) out.push(`    recall disabled -> tkr restore disabled (${restoreConfigFile()})`);
    else if (c.retentionDays) out.push(`    recall retention ${c.retentionDays} days -> tkr restore keeps outputs ${c.retentionDays} days (${restoreConfigFile()})`);
    if (c.telemetryOff) out.push(plan.telemetryOn ? "    telemetry off -> tkr telemetry off" : "    telemetry off: Tokmizer telemetry is already off");
    if (c.notImported.length > 0) out.push(`    no Tokmizer equivalent, not imported: ${c.notImported.join(", ")}`);
  }
  out.push("", "History");
  if (!plan.history) out.push("  no rtk history.db found");
  else if (plan.history.error) out.push(`  ${plan.history.file}: skipped, ${plan.history.error}`);
  else if (plan.history.totals) {
    out.push(`  ${plan.history.file}: read-only`);
    const t = plan.history.totals;
    out.push(`  ${t.savedTokens} tokens saved over ${plural(t.commands, "command")}${t.firstAt && t.lastAt ? `, ${t.firstAt.slice(0, 10)} to ${t.lastAt.slice(0, 10)}` : ""} (rtk's own estimate)`);
    out.push("  shown on its own line in tkr gain, never added to Tokmizer's measured totals");
  }
  out.push("", "Agent hooks");
  if (plan.hooks.length === 0) out.push("  no rtk hook found");
  for (const h of plan.hooks) {
    for (const edit of h.edits) {
      out.push(h.tkrInstalled
        ? `  ${h.agent}: remove ${edit.what} from ${edit.file}`
        : `  ${h.agent}: rtk kept in ${edit.file}, Tokmizer is not set up there (${h.tkrSetup}, then run tkr migrate rtk again)`);
    }
    for (const note of h.notes) out.push(`  ${h.agent}: ${note}`);
  }
  if (plan.shim) out.push("", "rtk command", `  write ${plan.shim.file}: rtk gain, rtk recall and rtk bypass forward to Tokmizer`);
  out.push("", "Every changed file is backed up. Undo with: tkr migrate rtk --undo", "");
  return out.join("\n");
}

class Recorder {
  readonly dir: string;
  readonly manifest: Manifest;
  private seen = new Map<string, FileRecord>();

  constructor(dir: string) {
    this.dir = dir;
    this.manifest = { v: 1, createdAt: new Date().toISOString(), files: [] };
  }

  async snapshot(path: string): Promise<FileRecord> {
    const known = this.seen.get(path);
    if (known) return known;
    let backup: string | null = null;
    if (existsSync(path)) {
      backup = join(this.dir, "files", String(this.manifest.files.length));
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
      await copyFile(path, backup);
    }
    const record: FileRecord = { path, backup, after: null };
    this.seen.set(path, record);
    this.manifest.files.push(record);
    await this.save();
    return record;
  }

  async write(path: string, content: string, mode?: number): Promise<void> {
    const record = await this.snapshot(path);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, content);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
    record.after = fileHash(path);
  }

  async remove(path: string): Promise<void> {
    const record = await this.snapshot(path);
    await rm(path, { force: true });
    record.after = null;
  }

  settle(path: string): void {
    const record = this.seen.get(path);
    if (record) record.after = fileHash(path);
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.dir, "manifest.json"), `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600 });
  }
}

export async function applyPlan(plan: MigrationPlan): Promise<string[]> {
  const work = pendingWork(plan);
  if (work.steps.length === 0 && work.trust.length === 0 && !work.telemetry) return ["Already migrated: nothing to change."];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rec = new Recorder(join(migrationsDir(), stamp));
  const done: string[] = [];
  for (const step of work.steps) {
    if (step.content === null) await rec.remove(step.path);
    else await rec.write(step.path, step.content, step.mode);
    done.push(step.done);
  }
  if (work.trust.length > 0) {
    await rec.snapshot(userFiltersTrustFile());
    await trustUserFilters(work.trust);
    rec.settle(userFiltersTrustFile());
    done.push(`Trusted ${work.trust.join(", ")}`);
  }
  __resetUserFilters();
  if (work.telemetry) {
    rec.manifest.telemetryWas = true;
    await rec.save();
    try {
      await patchSettings({ telemetryOptIn: false });
      done.push("Telemetry off");
    } catch (err) {
      done.push(`Telemetry: could not turn it off (${(err as Error).message}). Run: tkr telemetry off`);
    }
  }
  await rec.save();
  done.push(`Backups: ${rec.dir}`);
  return done;
}

function openManifests(): Array<{ dir: string; manifest: Manifest }> {
  let names: string[];
  try {
    names = readdirSync(migrationsDir()).sort().reverse();
  } catch {
    return [];
  }
  const open: Array<{ dir: string; manifest: Manifest }> = [];
  for (const name of names) {
    try {
      const manifest = JSON.parse(readFileSync(join(migrationsDir(), name, "manifest.json"), "utf8")) as Manifest;
      if (!manifest.undoneAt) open.push({ dir: join(migrationsDir(), name), manifest });
    } catch {}
  }
  return open;
}

async function undoOne(entry: { dir: string; manifest: Manifest }, lines: string[]): Promise<boolean> {
  let ok = true;
  for (const record of [...entry.manifest.files].reverse()) {
    if (fileHash(record.path) !== record.after) {
      lines.push(`Kept ${record.path}: it changed after the migration.${record.backup ? ` Its previous version is in ${record.backup}` : ""}`);
      ok = false;
      continue;
    }
    if (record.backup) {
      await mkdir(dirname(record.path), { recursive: true });
      await copyFile(record.backup, record.path);
      lines.push(`Restored ${record.path}`);
    } else {
      await rm(record.path, { force: true });
      lines.push(`Removed ${record.path}`);
    }
  }
  if (entry.manifest.telemetryWas !== undefined) {
    try {
      await patchSettings({ telemetryOptIn: entry.manifest.telemetryWas });
      lines.push(`Telemetry ${entry.manifest.telemetryWas ? "on" : "off"} again`);
    } catch (err) {
      lines.push(`Telemetry: could not restore it (${(err as Error).message})`);
      ok = false;
    }
  }
  entry.manifest.undoneAt = new Date().toISOString();
  await writeFile(join(entry.dir, "manifest.json"), `${JSON.stringify(entry.manifest, null, 2)}\n`, { mode: 0o600 });
  lines.push(`Undid the rtk migration of ${entry.manifest.createdAt}.`);
  return ok;
}

export async function undoMigration(): Promise<{ lines: string[]; ok: boolean }> {
  const open = openManifests();
  if (open.length === 0) return { lines: ["Nothing to undo: no rtk migration found."], ok: true };
  const lines: string[] = [];
  let ok = true;
  for (const entry of open) {
    if (!(await undoOne(entry, lines))) ok = false;
  }
  __resetUserFilters();
  if (open.length > 1) lines.push(`${open.length} migrations undone, newest first.`);
  return { lines, ok };
}

export function rtkMigrationHint(e: RtkEnv): string | null {
  try {
    if (existsSync(migrationsDir())) return null;
    const binary = findRtkBinary(e, [shimsDir()], false);
    if (!binary || binary.compatShim) return null;
    return "rtk is installed too. Move its filters, settings and history, and stop wrapping commands twice: tkr migrate rtk";
  } catch {
    return null;
  }
}
