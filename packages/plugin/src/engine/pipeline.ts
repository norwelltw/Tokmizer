import type { FilterDef } from "./schema";
import { stripAnsi } from "./transforms/strip-ansi";
import { stripLinesMatching } from "./transforms/strip-lines";
import { truncateLinesAt } from "./transforms/truncate-lines";
import { headTailLines, omissionMarker } from "./transforms/max-lines";
import { foldPassing, FAILURE } from "./transforms/fold-passing";
import { maskAbsPaths } from "./transforms/mask-abs-paths";
import { smartCodeCollapse, looksLikeCode, foldPaddingMask } from "./transforms/smart-code";
import {
  dedupeAdjacent,
  collapseBlankRuns,
  dropVerboseLogs
} from "./transforms/prompt-compress";
import { getTransform } from "./transforms/registry";
import "./transforms/smart-ls";
import "./transforms/smart-read";
import "./transforms/smart-find";
import "./transforms/smart-wc";
import "./transforms/smart-ctest";
import "./transforms/smart-phpstan";
import "./transforms/bun-frames";
import "./transforms/smart-grep";
import "./transforms/smart-log";
import "./transforms/strip-banners";
import "./transforms/squeeze-output";

export function capMultiplier(verbosity: "normal" | "compact" | "minimal" | undefined): number {
  if (verbosity === "compact") return 0.6;
  if (verbosity === "minimal") return 0.3;
  return 1.0;
}

const CAP_FLOOR = 20;

function compactTestSummary(lines: string[]): string[] {
  const [files, tests, started, elapsed] = lines.slice(-4);
  if (
    !files || !tests || !started || !elapsed ||
    !/^\s*Test Files\s+([1-9]\d*) passed \(\1\)$/.test(files) ||
    !/^\s*Tests\s+([1-9]\d*) passed \(\1\)$/.test(tests) ||
    !/^\s*Start at\s+\d{2}:\d{2}:\d{2}$/.test(started)
  ) return lines;
  const duration = /^(\s*Duration\s+\d+(?:\.\d+)?(?:ms|s)) \(transform [^\n]+\)$/.exec(elapsed)?.[1];
  if (!duration) return lines;
  const body = lines.slice(0, -4).filter((line, index) => index > 2 || !/^ RUN  v\d+\.\d+\.\d+(?:[\w.+-]*) .+$/.test(line));
  return [...body, files, tests, duration];
}

type Compiled = {
  def: FilterDef;
  stripRegexes: RegExp[];
  dropRegexes: RegExp[];
};

const COMPILED = new WeakMap<FilterDef, Compiled>();

function compile(def: FilterDef): Compiled {
  const cached = COMPILED.get(def);
  if (cached) return cached;
  const stripRegexes = def.strip_lines_matching.map((p) => new RegExp(p));
  const dropRegexes = (def.drop_lines_matching ?? []).map((p) => new RegExp(p));
  const c: Compiled = { def, stripRegexes, dropRegexes };
  COMPILED.set(def, c);
  return c;
}

export type PipelineOpts = {
  verbosity?: "normal" | "compact" | "minimal";
  smartCode?: boolean;
};

export function applyFilter(input: string, def: FilterDef, opts: PipelineOpts = {}): string {
  return applyFilterWithTail(input, def, opts).text;
}

export function applyFilterWithTail(
  input: string,
  def: FilterDef,
  opts: PipelineOpts = {}
): { text: string; droppedTail: string | null } {
  const verbosity = opts.verbosity ?? "normal";
  if (
    !def.strip_ansi && def.strip_lines_matching.length === 0 && (def.drop_lines_matching ?? []).length === 0 && !def.transform &&
    !def.mask_abs_paths && !def.fold_passing && !def.truncate_lines_at &&
    !def.max_lines && !def.on_empty && !opts.smartCode && verbosity === "normal"
  ) {
    return { text: input, droppedTail: null };
  }
  const c = compile(def);
  let text = !def.preserve_exact && input.includes("\r\n") ? input.replace(/\r\n/g, "\n") : input;
  if (def.strip_ansi) text = stripAnsi(text);

  const trailingNewline = text.endsWith("\n");
  let lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");

  if (c.stripRegexes.length) {
    lines = def.keep_failures
      ? lines.filter((l) => FAILURE.test(l) || !c.stripRegexes.some((p) => p.test(l)))
      : stripLinesMatching(lines, c.stripRegexes);
  }
  if (c.dropRegexes.length) lines = stripLinesMatching(lines, c.dropRegexes);

  if (verbosity !== "normal" && !def.preserve_exact) {
    lines = dedupeAdjacent(lines);
    lines = collapseBlankRuns(lines);
  }
  if (verbosity === "minimal" && !def.preserve_exact) {
    lines = dropVerboseLogs(lines);
    if (def.slug === "vitest" || def.slug === "npm-test") lines = compactTestSummary(lines);
  }

  const minimumReadSpan = def.transform === "smart-read" && opts.smartCode !== true
    ? verbosity === "compact" ? 8 : verbosity === "minimal" ? 6 : 3
    : 3;
  if (!def.preserve_exact && (opts.smartCode || (opts.smartCode === undefined && verbosity !== "normal" && looksLikeCode(text)))) {
    lines = smartCodeCollapse(lines, minimumReadSpan);
  }

  if (def.transform) {
    const tf = getTransform(def.transform);
    if (def.transform === "smart-read") lines = smartCodeCollapse(lines, minimumReadSpan, def.slug === "read-tool");
    else if (tf) lines = tf(lines);
  }

  const keepNumbering = def.slug === "read-tool";
  if (!keepNumbering) {
    const pad = foldPaddingMask(lines);
    if (pad.some(Boolean)) lines = lines.filter((_, i) => !pad[i]);
  }

  if (def.mask_abs_paths) {
    lines = maskAbsPaths(lines);
  }
  if (def.fold_passing) {
    lines = foldPassing(lines, def.fold_passing_threshold ?? 5);
  }
  if (def.truncate_lines_at) {
    lines = truncateLinesAt(lines, def.truncate_lines_at);
  }
  let droppedTail: string | null = null;
  if (def.max_lines) {
    const mult = def.scale_with_level ? capMultiplier(opts.verbosity) : 1.0;
    const effectiveCap = Math.min(def.max_lines, Math.max(CAP_FLOOR, Math.round(def.max_lines * mult)));
    const pad = keepNumbering ? foldPaddingMask(lines) : null;
    const meaningful = pad ? pad.filter((x) => !x).length : lines.length;
    if (meaningful > effectiveCap) {
      let cut = effectiveCap;
      if (pad) {
        let seen = 0;
        cut = 0;
        while (cut < lines.length && seen < effectiveCap) {
          if (!pad[cut]) seen += 1;
          cut += 1;
        }
      }
      const omitted = meaningful - effectiveCap;
      if (def.keep_failures) {
        const tail = lines.slice(cut);
        const nonFailureTail = tail.filter((l) => !FAILURE.test(l));
        const omitted = tail.reduce((count, line, i) => count + (!FAILURE.test(line) && !pad?.[cut + i] ? 1 : 0), 0);
        droppedTail = nonFailureTail.length > 0 ? nonFailureTail.join("\n") : null;
        lines = [...lines.slice(0, cut), ...(omitted > 0 ? [omissionMarker(omitted)] : []), ...tail.filter((l) => FAILURE.test(l))];
      } else if (keepNumbering) {
        droppedTail = lines.slice(cut).join("\n");
        lines = [...lines.slice(0, cut), omissionMarker(omitted)];
      } else {
        const { kept, dropped } = headTailLines(lines, effectiveCap);
        droppedTail = dropped.length > 0 ? dropped.join("\n") : null;
        lines = kept;
      }
    }
  }

  let out = lines.join("\n");
  if (trailingNewline && out.length > 0) out += "\n";
  if (out.trim().length === 0 && def.on_empty) out = def.on_empty;
  return { text: out, droppedTail };
}
