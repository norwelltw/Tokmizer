#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATORS } from "./synthetic.mjs";

const CAP = 30000;
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooks = join(plugin, "dist", "hooks-host");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function tokenizer() {
  const require = createRequire(join(plugin, "package.json"));
  try {
    const { getEncoding } = await import(require.resolve("js-tiktoken"));
    const encoding = getEncoding("o200k_base");
    return { label: "o200k_base (js-tiktoken)", count: (text) => encoding.encode(text).length };
  } catch {}
  try {
    const { countTokens } = await import(require.resolve("@anthropic-ai/tokenizer"));
    return { label: "@anthropic-ai/tokenizer", count: (text) => countTokens(text) };
  } catch {}
  return { label: "approximation: characters / 4 (no tokenizer installed)", count: (text) => Math.ceil(text.length / 4) };
}

function quote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function cleanPath() {
  return (process.env.PATH ?? "").split(delimiter).filter((entry) => entry && !/[\\/]\.tokmizer[\\/]/.test(entry)).join(delimiter);
}

function prepare(work, item, raw) {
  const fixture = join(work, "output.txt");
  writeFileSync(fixture, raw);
  const bin = join(work, "bin");
  const cwd = join(work, "project");
  const home = join(work, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const head = item.command.split(/\s+/)[0];
  const fake = head.includes("/") ? join(cwd, head) : join(bin, head);
  mkdirSync(dirname(fake), { recursive: true });
  writeFileSync(fake, `#!/bin/sh\n/bin/cat ${quote(fixture)}${item.stream === "stderr" ? " >&2" : ""}\nexit ${item.exit}\n`);
  chmodSync(fake, 0o755);
  const env = {
    PATH: `${bin}${delimiter}${cleanPath()}`,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: work,
    LANG: "C.UTF-8",
    TOKMIZER_HOME: join(home, ".tokmizer"),
    TOKMIZER_NETWORK: "0",
    TOKMIZER_AUTO_UPDATE: "0",
    TOKMIZER_DAEMON_BIN: join(work, "no-daemon.js"),
    CLAUDE_CONFIG_DIR: join(home, ".claude")
  };
  return { cwd, env, work };
}

function hook(name, payload, context) {
  const run = spawnSync(process.execPath, [join(hooks, `${name}.js`)], { input: JSON.stringify(payload), env: context.env, cwd: context.cwd, encoding: "utf8", timeout: 60000, maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`${name} hook failed: ${run.stderr}`);
  if (!run.stdout.trim()) return null;
  return JSON.parse(run.stdout).hookSpecificOutput ?? null;
}

function joined(stdout, stderr) {
  return [stdout, stderr].filter(Boolean).join("\n");
}

function postTool(session, command, stdout, stderr, context) {
  const response = { stdout, stderr, interrupted: false, isImage: false };
  if (stdout.length > CAP) {
    const results = join(context.work, "tool-results");
    mkdirSync(results, { recursive: true });
    const persisted = join(results, `${session}.txt`);
    writeFileSync(persisted, stdout);
    Object.assign(response, { stdout: stdout.slice(0, CAP), persistedOutputPath: persisted, persistedOutputSize: Buffer.byteLength(stdout) });
  }
  const payload = { session_id: session, cwd: context.cwd, hook_event_name: "PostToolUse", tool_name: "Bash", permission_mode: "default", tool_input: { command }, tool_response: response };
  const updated = hook("post-tool-use", payload, context)?.updatedToolOutput;
  return updated ? joined(updated.stdout ?? "", updated.stderr ?? "") : null;
}

function defaultMode(item, raw, context) {
  if (item.exit !== 0) return raw;
  const stdout = item.stream === "stderr" ? "" : raw;
  const stderr = item.stream === "stderr" ? raw : "";
  return postTool(`${item.id}-default`, item.command, stdout, stderr, context) ?? raw;
}

function rewrittenMode(item, raw, context) {
  const session = `${item.id}-rewritten`;
  const pre = hook("pre-tool-use", { session_id: session, cwd: context.cwd, hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: item.command } }, context);
  const command = pre?.updatedInput?.command ?? item.command;
  const run = spawnSync("/bin/sh", ["-c", command], { env: context.env, cwd: context.cwd, encoding: "utf8", timeout: 60000, maxBuffer: 256 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== item.exit) throw new Error(`${item.id}: expected exit ${item.exit}, got ${run.status}: ${run.stderr.slice(0, 400)}`);
  const output = joined(run.stdout, run.stderr);
  const final = run.status === 0 ? postTool(session, command, run.stdout, run.stderr, context) ?? output : output;
  return { output: final, rewritten: command !== item.command };
}

function slice(name, rows, count, measure) {
  const total = (key) => rows.reduce((sum, row) => sum + measure(row[key], count), 0);
  const raw = total("raw");
  const pct = (key) => (raw ? Math.round(1000 * (1 - total(key) / raw)) / 10 : 0);
  return { slice: name, cases: rows.length, rawTokens: raw, reductionPercent: { tokmizerDefaultMode: pct("defaultMode"), tokmizerCommandsRewritten: pct("commandsRewritten") } };
}

async function main() {
  if (!existsSync(join(hooks, "pre-tool-use.js"))) throw new Error(`missing ${hooks}: build the plugin first (npm --workspace packages/plugin run build)`);
  if (process.platform === "win32") throw new Error("the benchmark replays commands through /bin/sh and runs on macOS or Linux only");
  const corpusFile = option("--corpus") ? resolve(option("--corpus")) : join(plugin, "bench", "corpus.json");
  const corpusRoot = option("--corpus") ? dirname(corpusFile) : plugin;
  const corpus = JSON.parse(readFileSync(corpusFile, "utf8")).cases;
  const only = option("--only")?.split(",");
  const items = only ? corpus.filter((item) => only.includes(item.id)) : corpus;
  const counter = await tokenizer();
  const base = mkdtempSync(join(tmpdir(), "tkr-bench-"));
  const rows = [];
  try {
    for (const item of items) {
      const raw = item.generate ? GENERATORS[item.generate]() : readFileSync(join(corpusRoot, item.file), "utf8");
      const work = join(base, item.id);
      mkdirSync(work);
      const context = prepare(work, item, raw);
      const rewritten = rewrittenMode(item, raw, context);
      const row = { id: item.id, command: item.command, exit: item.exit, chars: raw.length, rewritten: rewritten.rewritten, raw, defaultMode: defaultMode(item, raw, context), commandsRewritten: rewritten.output };
      rows.push(row);
      if (process.argv.includes("--verbose")) {
        const t = (text) => counter.count(text);
        console.log(`${item.id.padEnd(40)} raw ${String(t(raw)).padStart(7)}  default ${String(t(row.defaultMode)).padStart(7)}  rewritten ${String(t(row.commandsRewritten)).padStart(7)}${row.rewritten ? "" : "  (not rewritten)"}`);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const full = (text, count) => count(text);
  const capped = (text, count) => count(text.slice(0, CAP));
  const tokens = (text) => counter.count(text);
  const report = {
    schemaVersion: 1,
    measuredOn: new Date().toISOString().slice(0, 10),
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    plugin: JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")).version,
    tokenizer: counter.label,
    conditions: "Each output replayed offline through the built Claude Code hooks: TOKMIZER_NETWORK=0, a fresh temporary home per case, no account. Default mode: the after-command hook runs only when the command succeeds. Commands rewritten: bypassPermissions, the before-command hook rewrites the command, which then runs through tkr-exec against a stand-in binary that prints the saved output.",
    cases: rows.length,
    notRewritten: rows.filter((row) => !row.rewritten).map((row) => row.id),
    slices: [
      slice("all", rows, tokens, full),
      slice("claude-code-30k-cap", rows, tokens, capped),
      slice("outputs-under-30k-chars", rows.filter((row) => row.chars < CAP), tokens, full)
    ],
    rows: rows.map((row) => ({ id: row.id, command: row.command, exit: row.exit, chars: row.chars, rewritten: row.rewritten, rawTokens: tokens(row.raw), defaultModeTokens: tokens(row.defaultMode), commandsRewrittenTokens: tokens(row.commandsRewritten) }))
  };
  const out = option("--out");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`Tokmizer ${report.plugin}, ${report.cases} cases, tokens: ${report.tokenizer}`);
  console.log("slice                         cases   raw tokens   default mode   commands rewritten");
  for (const s of report.slices) {
    console.log(`${s.slice.padEnd(28)} ${String(s.cases).padStart(6)} ${String(s.rawTokens).padStart(12)} ${`${s.reductionPercent.tokmizerDefaultMode}%`.padStart(14)} ${`${s.reductionPercent.tokmizerCommandsRewritten}%`.padStart(20)}`);
  }
  if (report.notRewritten.length) console.log(`not rewritten by the hook: ${report.notRewritten.join(", ")}`);
}

main().catch((error) => {
  console.error(`bench: ${error.message}`);
  process.exit(1);
});
