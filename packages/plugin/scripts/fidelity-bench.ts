import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processToolOutput } from "../src/hooks-host/post-tool-process";
import { processCapturedOutput } from "../src/exec/wrapper";
import { restoreCommand } from "../src/content-cache";
import { FOLD_MARKER_RE } from "../src/engine/transforms/smart-code";
import { READ_EDIT_NOTICE } from "../src/engine/read-notice";
import { __resetCache } from "../src/engine/loader";

export type Verbosity = "normal" | "compact" | "minimal";
export type Mode = "post" | "exec" | "read";

type FactField = "test" | "location" | "message" | "expected" | "actual" | "assertion" | "diff";
type Failure = Record<Exclude<FactField, "diff">, string> & { diff?: string };
type FactSheet = { command: string; exitCode: number; stream: "stdout" | "stderr"; failures: Failure[] };

type Delivery = {
  key: string;
  volet: "facts" | "editSafety";
  fixture: string;
  mode: Mode;
  verbosity: Verbosity;
  original: string;
  raw: string;
  delivered: string;
};

type VoletReport<T> = {
  cases: number;
  passed: number;
  failed: number;
  approxTokensRemoved: number;
  failures: T[];
};

export type FidelityReport = {
  note: string;
  verbosities: Verbosity[];
  volets: {
    facts: VoletReport<{ fixture: string; mode: Mode; verbosity: Verbosity; test: string; field: FactField; value: string }> & { regroupedLocations: number };
    editSafety: VoletReport<{ fixture: string; mode: Mode; verbosity: Verbosity; line: number; text: string; codeLike: boolean }>;
    restore: VoletReport<{ key: string; reason: string }> & { intact: number; restored: number };
    determinism: VoletReport<{ key: string }>;
  };
  cases: { key: string; rawChars: number; deliveredChars: number; changed: boolean }[];
};

export const VERBOSITIES: Verbosity[] = ["normal", "compact", "minimal"];
const FACT_FIELDS: FactField[] = ["test", "location", "message", "expected", "actual", "assertion", "diff"];
const FIXTURE_ROOT = fileURLToPath(new URL("../src/__tests__/fixtures/fidelity/", import.meta.url));
const SOURCE_COMMANDS: Record<string, string> = {
  "checkout-repositories.ts": "src/checkout/repositories.ts",
  "back-office-reports.py": "reports/back_office.py",
  "catalog-stores.go": "internal/catalog/stores.go"
};
const PROJECT_CWD = "/home/dev/project";
const OMISSION_RE = /^… \(?\d+ more lines omitted\)?$/;
const RESTORE_RE = /^\[tkr restore [0-9a-f]{8,64}\]$/;
const RESTORE_ID_RE = /^\[tkr restore ([0-9a-f]{8,64})\]$/gm;
const CODE_LIKE_RE = /[{}();=<>[\]]|^\s*(?:import|export|from|def|class|func|return|const|let|var|type|package|if|for|while)\b/;
const ENV_KEYS = ["HOME", "TOKMIZER_HOME", "TOKMIZER_NETWORK", "TOKMIZER_DEV", "TOKMIZER_CCR_DISABLED", "CLAUDE_CODE_SESSION_ID"] as const;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function approxTokens(chars: number): number {
  return Math.round(chars / 4);
}

function merged(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n");
}

async function loadFactFixtures(): Promise<{ name: string; text: string; sheet: FactSheet }[]> {
  const dir = join(FIXTURE_ROOT, "failures");
  const names = (await readdir(dir)).filter((n) => n.endsWith(".txt")).sort();
  return Promise.all(names.map(async (file) => {
    const name = file.slice(0, -4);
    const text = await readFile(join(dir, file), "utf8");
    const sheet = JSON.parse(await readFile(join(dir, `${name}.facts.json`), "utf8")) as FactSheet;
    return { name, text, sheet };
  }));
}

async function loadSources(): Promise<{ name: string; path: string; text: string }[]> {
  const dir = join(FIXTURE_ROOT, "sources");
  const names = (await readdir(dir)).filter((n) => SOURCE_COMMANDS[n]).sort();
  return Promise.all(names.map(async (name) => ({ name, path: SOURCE_COMMANDS[name]!, text: await readFile(join(dir, name), "utf8") })));
}

async function viaExec(command: string, stdout: string, stderr: string, exitCode: number): Promise<string> {
  const result = await processCapturedOutput(
    { argv: command.split(/\s+/), stdout, stderr, exitCode, truncated: false, stderrTruncated: false },
    { yolo: false, env: process.env, cwd: PROJECT_CWD }
  );
  return merged(result.stdout, result.stderr);
}

async function viaPostBash(command: string, stdout: string, stderr: string, exitCode: number): Promise<string> {
  const out = await processToolOutput({
    cwd: PROJECT_CWD,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout, stderr, ...(exitCode !== 0 ? { returnCodeInterpretation: `exit code ${exitCode}` } : {}) }
  }, { inferCwd: false });
  return out ?? merged(stdout, stderr);
}

async function viaPostRead(filePath: string, content: string): Promise<string> {
  const out = await processToolOutput({
    cwd: PROJECT_CWD,
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_response: { file: { content } }
  }, { inferCwd: false });
  return out ?? content;
}

async function useVerbosity(home: string, verbosity: Verbosity): Promise<void> {
  await writeFile(join(home, "settings-cache.json"), JSON.stringify({ outputVerbosity: verbosity }), { mode: 0o600 });
}

async function deliverAll(home: string): Promise<Delivery[]> {
  const facts = await loadFactFixtures();
  const sources = await loadSources();
  const out: Delivery[] = [];
  for (const verbosity of VERBOSITIES) {
    await useVerbosity(home, verbosity);
    for (const { name, text, sheet } of facts) {
      const stdout = sheet.stream === "stdout" ? text : "";
      const stderr = sheet.stream === "stderr" ? text : "";
      for (const mode of ["post", "exec"] as const) {
        const delivered = mode === "post"
          ? await viaPostBash(sheet.command, stdout, stderr, sheet.exitCode)
          : await viaExec(sheet.command, stdout, stderr, sheet.exitCode);
        out.push({ key: `facts/${name}/${mode}/${verbosity}`, volet: "facts", fixture: name, mode, verbosity, original: text, raw: merged(stdout, stderr), delivered });
      }
    }
    for (const { name, path, text } of sources) {
      const command = `cat ${path}`;
      for (const mode of ["post", "exec", "read"] as const) {
        const delivered = mode === "read"
          ? await viaPostRead(`${PROJECT_CWD}/${path}`, text)
          : mode === "post"
            ? await viaPostBash(command, text, "", 0)
            : await viaExec(command, text, "", 0);
        out.push({ key: `editSafety/${name}/${mode}/${verbosity}`, volet: "editSafety", fixture: name, mode, verbosity, original: text, raw: text, delivered });
      }
    }
  }
  return out;
}

function regroupedLocation(delivered: string, failure: Failure): boolean {
  const at = failure.location.lastIndexOf(":");
  const file = failure.location.slice(0, at);
  const line = failure.location.slice(at + 1);
  const lines = delivered.split("\n");
  const header = lines.findIndex((l) => l.trim() === file);
  if (header === -1) return false;
  const test = normalize(failure.test);
  const lineRef = new RegExp(`:${line}(?::\\d+)?\\s*$`);
  for (const l of lines.slice(header + 1)) {
    if (/^\S/.test(l) && !/^[×✕⨯]/.test(l)) break;
    if (normalize(l).includes(test) && lineRef.test(l)) return true;
  }
  return false;
}

function checkFacts(deliveries: Delivery[], sheets: Map<string, FactSheet>): FidelityReport["volets"]["facts"] {
  const failures: FidelityReport["volets"]["facts"]["failures"] = [];
  let passed = 0;
  let regroupedLocations = 0;
  const cases = deliveries.filter((d) => d.volet === "facts");
  for (const d of cases) {
    const haystack = normalize(d.delivered);
    const missing = sheets.get(d.fixture)!.failures.flatMap((failure) => FACT_FIELDS
      .filter((field) => {
        if (failure[field] === undefined || haystack.includes(normalize(failure[field]))) return false;
        if (field === "location" && regroupedLocation(d.delivered, failure)) {
          regroupedLocations += 1;
          return false;
        }
        return true;
      })
      .map((field) => ({ fixture: d.fixture, mode: d.mode, verbosity: d.verbosity, test: failure.test, field, value: failure[field]! })));
    if (missing.length === 0) passed += 1;
    failures.push(...missing);
  }
  return { cases: cases.length, passed, failed: cases.length - passed, regroupedLocations, approxTokensRemoved: removed(cases), failures };
}

function annotation(line: string): boolean {
  return FOLD_MARKER_RE.test(line) || OMISSION_RE.test(line) || RESTORE_RE.test(line) || line === READ_EDIT_NOTICE;
}

function checkEditSafety(deliveries: Delivery[]): FidelityReport["volets"]["editSafety"] {
  const failures: FidelityReport["volets"]["editSafety"]["failures"] = [];
  let passed = 0;
  const cases = deliveries.filter((d) => d.volet === "editSafety");
  for (const d of cases) {
    const known = new Set(d.original.split("\n"));
    const bad = d.delivered.split("\n").flatMap((text, i) => known.has(text) || annotation(text)
      ? []
      : [{ fixture: d.fixture, mode: d.mode, verbosity: d.verbosity, line: i + 1, text, codeLike: CODE_LIKE_RE.test(text) }]);
    if (bad.length === 0) passed += 1;
    failures.push(...bad);
  }
  return { cases: cases.length, passed, failed: cases.length - passed, approxTokensRemoved: removed(cases), failures };
}

async function checkRestore(deliveries: Delivery[]): Promise<FidelityReport["volets"]["restore"]> {
  const failures: FidelityReport["volets"]["restore"]["failures"] = [];
  let intact = 0;
  let restored = 0;
  for (const d of deliveries) {
    if (d.delivered === d.raw) {
      intact += 1;
      continue;
    }
    const ids = [...d.delivered.matchAll(RESTORE_ID_RE)].map((m) => m[1]!);
    if (ids.length === 0) {
      failures.push({ key: d.key, reason: "output changed but carries no [tkr restore] id" });
      continue;
    }
    let ok = false;
    const reasons: string[] = [];
    for (const id of ids) {
      const result = await restoreCommand([id]);
      if (result.code === 0 && result.stdout === d.original) ok = true;
      else reasons.push(`${id}: ${result.code !== 0 ? (result.stderr ?? "").trim() : `restored ${result.stdout?.length ?? 0} chars, original ${d.original.length}${result.stderr ? `, ${result.stderr.trim()}` : ""}`}`);
    }
    if (ok) restored += 1;
    else failures.push({ key: d.key, reason: reasons.join("; ") });
  }
  return { cases: deliveries.length, passed: intact + restored, failed: failures.length, intact, restored, approxTokensRemoved: removed(deliveries), failures };
}

function checkDeterminism(first: Delivery[], second: Delivery[]): FidelityReport["volets"]["determinism"] {
  const other = new Map(second.map((d) => [d.key, d.delivered]));
  const failures = first.filter((d) => other.get(d.key) !== d.delivered).map((d) => ({ key: d.key }));
  if (other.size !== first.length) failures.push({ key: `case count ${first.length} vs ${other.size}` });
  return { cases: first.length, passed: first.length - failures.length, failed: failures.length, approxTokensRemoved: removed(first), failures };
}

function removed(cases: Delivery[]): number {
  return approxTokens(cases.reduce((sum, d) => sum + d.raw.length - d.delivered.length, 0));
}

async function freshHome(root: string, label: string): Promise<string> {
  const home = join(root, label);
  const tokmizer = join(home, ".tokmizer");
  await mkdir(tokmizer, { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  process.env.TOKMIZER_HOME = tokmizer;
  return tokmizer;
}

export async function runFidelityBench(): Promise<FidelityReport> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const root = await realpath(await mkdtemp(join(tmpdir(), "tkr-fidelity-")));
  try {
    process.env.TOKMIZER_NETWORK = "0";
    process.env.TOKMIZER_DEV = "1";
    delete process.env.TOKMIZER_CCR_DISABLED;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    __resetCache();
    const first = await deliverAll(await freshHome(root, "run-a"));
    const sheets = new Map((await loadFactFixtures()).map((f) => [f.name, f.sheet]));
    const facts = checkFacts(first, sheets);
    const editSafety = checkEditSafety(first);
    const restore = await checkRestore(first);
    __resetCache();
    const second = await deliverAll(await freshHome(root, "run-b"));
    const determinism = checkDeterminism(first, second);
    return {
      note: "approxTokensRemoved = (raw chars - delivered chars) / 4, an approximation, not provider billing or task success.",
      verbosities: VERBOSITIES,
      volets: { facts, editSafety, restore, determinism },
      cases: first.map((d) => ({ key: d.key, rawChars: d.raw.length, deliveredChars: d.delivered.length, changed: d.delivered !== d.raw }))
    };
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetCache();
    await rm(root, { recursive: true, force: true });
  }
}

export function mandatoryFailures(report: FidelityReport): string[] {
  const { facts, editSafety, restore, determinism } = report.volets;
  return [
    ...facts.failures.map((f) => `facts ${f.fixture} ${f.mode} ${f.verbosity}: missing ${f.field} ${JSON.stringify(f.value)}`),
    ...restore.failures.map((f) => `restore ${f.key}: ${f.reason}`),
    ...determinism.failures.map((f) => `determinism ${f.key}: output differs between two runs`),
    ...editSafety.failures.map((f) => `edit-safety ${f.fixture} ${f.mode} ${f.verbosity}: foreign line ${f.line} ${JSON.stringify(f.text.slice(0, 100))}`)
  ];
}

export function summarize(report: FidelityReport): string {
  const { facts, editSafety, restore, determinism } = report.volets;
  const row = (label: string, v: VoletReport<unknown>, extra = ""): string =>
    `${label.padEnd(13)} ${String(v.passed).padStart(3)}/${String(v.cases).padEnd(3)} passed, ${v.failed} failed, ~${v.approxTokensRemoved} tokens removed (chars/4)${extra}`;
  const lines = [
    "fidelity-bench (offline, synthetic fixtures)",
    row("facts", facts),
    row("edit-safety", editSafety),
    row("restore", restore, `, ${restore.intact} intact, ${restore.restored} restored`),
    row("determinism", determinism)
  ];
  for (const f of facts.failures) lines.push(`  facts ${f.fixture} ${f.mode} ${f.verbosity}: missing ${f.field} ${JSON.stringify(f.value)}`);
  const grouped = new Map<string, typeof editSafety.failures>();
  for (const f of editSafety.failures) {
    const key = `${f.fixture} ${f.mode} ${f.verbosity}`;
    grouped.set(key, [...(grouped.get(key) ?? []), f]);
  }
  for (const [key, bad] of grouped) {
    lines.push(`  edit-safety ${key}: ${bad.length} foreign line(s), ${bad.filter((b) => b.codeLike).length} code-like, first at ${bad[0]!.line}: ${JSON.stringify(bad[0]!.text.slice(0, 100))}`);
  }
  for (const f of restore.failures) lines.push(`  restore ${f.key}: ${f.reason}`);
  for (const f of determinism.failures) lines.push(`  determinism ${f.key}`);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const report = await runFidelityBench();
  const failures = mandatoryFailures(report);
  const at = process.argv.indexOf("--report");
  if (at !== -1 && process.argv[at + 1]) await writeFile(process.argv[at + 1]!, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--check")) {
    process.stdout.write(failures.length ? `${failures.join("\n")}\n` : `fidelity-bench: no loss; facts ${report.volets.facts.passed}/${report.volets.facts.cases}, restore ${report.volets.restore.passed}/${report.volets.restore.cases}, determinism ${report.volets.determinism.passed}/${report.volets.determinism.cases}, edit-safety ${report.volets.editSafety.passed}/${report.volets.editSafety.cases}\n`);
  } else if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(summarize(report));
  }
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
