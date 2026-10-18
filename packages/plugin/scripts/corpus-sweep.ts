import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { applyFilter } from "../src/engine/pipeline.js";
import { loadFilters, __resetCache } from "../src/engine/loader.js";
import { selectFilter } from "../src/engine/matcher.js";

const PROJECTS = join(homedir(), ".claude", "projects");
const MAX_OUTPUTS = 8000;
const MIN_BASH_BYTES = 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const LEVELS: ("normal" | "compact" | "minimal")[] = ["normal", "compact", "minimal"];

type Pair = { synthetic: string; output: string };

function extract(result: Record<string, unknown>): Pair | null {
  if (typeof result.stdout === "string" || typeof result.stderr === "string") {
    const out = [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n");
    if (Buffer.byteLength(out, "utf8") < MIN_BASH_BYTES) return null;
    return { synthetic: "bash-tool: x", output: out };
  }
  if (result.type === "text" && result.file && typeof (result.file as Record<string, unknown>).content === "string") {
    return { synthetic: "read-tool: x", output: (result.file as Record<string, string>).content };
  }
  if (result.mode === "content" && typeof result.content === "string") {
    return { synthetic: "grep-tool: x", output: result.content };
  }
  if (Array.isArray(result.filenames)) {
    return { synthetic: "glob-tool: x", output: (result.filenames as string[]).join("\n") };
  }
  return null;
}

function* walkFiles(): Generator<string> {
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS);
  } catch {
    return;
  }
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(PROJECTS, d));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith(".jsonl")) yield join(PROJECTS, d, f);
  }
}

type Agg = {
  count: number;
  rawTokens: number;
  levelSaved: Record<string, number>;
};

async function main(): Promise<void> {
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
  const filterList = [...(await loadFilters()).values()];
  const aggs = new Map<string, Agg>();
  let collected = 0;

  outer: for (const file of walkFiles()) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.includes("toolUseResult")) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const result = obj.toolUseResult;
      if (!result || typeof result !== "object") continue;
      const pair = extract(result as Record<string, unknown>);
      if (!pair) continue;
      if (Buffer.byteLength(pair.output, "utf8") > MAX_BYTES) continue;
      const filter = selectFilter(pair.synthetic, filterList, null);
      if (!filter) continue;
      const slug = filter.slug;
      const rawTokens = Math.round(Buffer.byteLength(pair.output, "utf8") / 4);
      let agg = aggs.get(slug);
      if (!agg) {
        agg = { count: 0, rawTokens: 0, levelSaved: {} };
        aggs.set(slug, agg);
      }
      agg.count++;
      agg.rawTokens += rawTokens;
      for (const level of LEVELS) {
        const out = applyFilter(pair.output, filter, { verbosity: level });
        const saved = rawTokens - Math.round(Buffer.byteLength(out, "utf8") / 4);
        agg.levelSaved[level] = (agg.levelSaved[level] ?? 0) + saved;
      }
      if (++collected >= MAX_OUTPUTS) break outer;
    }
  }

  const out: string[] = [`Corpus: ${collected} real tool outputs from ~/.claude transcripts`, ""];
  for (const [slug, a] of [...aggs.entries()].sort((x, y) => y[1].rawTokens - x[1].rawTokens)) {
    out.push(
      `## ${slug}  (n=${a.count}, raw ~${a.rawTokens} tok, current filter saves ~${a.levelSaved["normal"] ?? 0} tok)`
    );
    for (const level of LEVELS) {
      out.push(`  level ${level}: +${a.levelSaved[level] ?? 0} tok`);
    }
    out.push("");
  }
  process.stdout.write(out.join("\n") + "\n");
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main();
}
