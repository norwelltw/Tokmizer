#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
process.env.TOKMIZER_DEV = "1";
if (!process.env.TOKMIZER_FILTERS_DIR) {
  process.env.TOKMIZER_FILTERS_DIR = new URL("../filters", import.meta.url).pathname;
}
const { extractBashRuns, aggregateReplay, processOutput } = await import("../dist/index.js");

const args = process.argv.slice(2);
const filesFlag = args.indexOf("--files");
const LIMIT = filesFlag >= 0 ? Number(args[filesFlag + 1]) : 25;

const root = join(homedir(), ".claude", "projects");
const files = [];
for (const dir of readdirSync(root)) {
  const d = join(root, dir);
  let entries = [];
  try {
    entries = readdirSync(d).filter((f) => f.endsWith(".jsonl"));
  } catch {
    continue;
  }
  for (const f of entries) files.push(join(d, f));
}
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const picked = files.slice(0, LIMIT);

const outcomes = [];
for (const fp of picked) {
  let runs = [];
  try {
    runs = extractBashRuns(readFileSync(fp, "utf8"));
  } catch {
    continue;
  }
  for (const r of runs) {
    const rawBytes = Buffer.byteLength(r.output);
    if (!rawBytes) continue;
    const res = await processOutput(r.command, r.output, null, { exitCode: 0 });
    outcomes.push({
      command: r.command,
      rawBytes,
      filteredBytes: res.filteredBytes,
      filterId: res.filterId
    });
  }
}

const report = aggregateReplay(outcomes);
console.log(`replay: ${report.totals.runs} bash runs from ${picked.length} transcripts`);
console.log(
  `routed: ${report.totals.routedPct.toFixed(1)}% · saved ${report.totals.savedTokens} tok · unrouted raw ${report.totals.lostTokens} tok`
);
console.log("");
console.log("label                          runs routed  rawTok  savedTok  lostTok");
for (const r of report.rows.slice(0, 25)) {
  console.log(
    `${r.label.padEnd(30).slice(0, 30)} ${String(r.runs).padStart(4)} ${String(r.routed).padStart(6)} ${String(r.rawTokens).padStart(7)} ${String(r.savedTokens).padStart(9)} ${String(r.lostTokens).padStart(8)}`
  );
}
console.log("");
console.log("note: transcripts carry no exit codes, replay assumes success (keep-failures paths not exercised)");
