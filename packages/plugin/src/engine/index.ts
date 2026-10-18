import { loadFilters, type LoadedFilter } from "./loader";
import { selectFilter } from "./matcher";
import { withUserFilters } from "./user-filters";
import { applyFilter, applyFilterWithTail, type PipelineOpts } from "./pipeline";
import { looksLikeFailure } from "./debug-detect";
import { routingCandidates, normalizeHead, lastSegment, producingSegment, unwrapRunner, TOOL_SYNTHETIC_RE } from "./routing";
import { yoloExcerpt } from "./yolo";
import { stripAnsi } from "./transforms/strip-ansi";
import { condenseLogNoise } from "./transforms/prompt-compress";
import { compactStructuredOutput } from "./compact-structured";
import { compactRepeatedDiagnostics } from "./repeated-diagnostics";
import { dedupeAdjacent } from "./transforms/prompt-compress";
import { collapseTscFileList, requestsTscListing } from "./tsc-listing";
import { summarizeTestFailures, TEST_COMMAND_RE } from "./test-failures";
import { defaultRulesRuntime } from "../default-rules";

export type RunResult = {
  output: string;
  filterId: string | null;
  rawBytes: number;
  filteredBytes: number;
  debugBypass: boolean;
  droppedTail?: string | null;
  failureSummary?: boolean;
};

export type FilterResolver = (cmd: string, allowed: Set<string> | null) => Promise<LoadedFilter | null>;

let activeResolver: FilterResolver | null = null;

export function setFilterResolver(r: FilterResolver | null): void {
  activeResolver = r;
}

async function defaultResolver(
  cmd: string,
  allowed: Set<string> | null
): Promise<LoadedFilter | null> {
  const filters = await loadFilters();
  if (filters.size > 0) return selectFilter(cmd, filters.values(), allowed, filters);
  const builtin = defaultRulesRuntime();
  return builtin ? builtin.selectFor(cmd, "free", allowed ? [...allowed] : undefined) : null;
}

export type ProcessOpts = PipelineOpts & { exitCode?: number | null | undefined; yolo?: boolean; resolver?: FilterResolver | undefined };

const EXIT_ONE_IS_FINDINGS =
  /^(?:grep|rg|find|eslint|ruff|flake8|mypy|prettier|biome|black|stylelint)(?:\s|$)|^git\s+(?:diff|grep)\b/;

const FALLBACK_MIN_BYTES = 2048;
const FAILURE_NOISE_MIN_BYTES = 8192;
export const READ_FOLD_MIN_BYTES = 32 * 1024;

function failureStripped(output: string, filter: LoadedFilter, verbosity: PipelineOpts["verbosity"]): string {
  const kept = applyFilter(output, {
    ...filter,
    keep_failures: true,
    fold_passing: false,
    mask_abs_paths: false,
    transform: undefined,
    truncate_lines_at: undefined,
    max_lines: undefined,
    on_empty: undefined
  }, { verbosity: "normal", smartCode: false });
  if (kept.trim().length === 0) return stripAnsi(output);
  if (verbosity !== "compact" && verbosity !== "minimal") return kept;
  const trailing = kept.endsWith("\n") ? "\n" : "";
  return dedupeAdjacent((trailing ? kept.slice(0, -1) : kept).split("\n")).join("\n") + trailing;
}

export async function processOutput(
  cmd: string,
  output: string,
  allowedSlugs: Set<string> | null,
  opts: ProcessOpts = {}
): Promise<RunResult> {
  const rawBytes = Buffer.byteLength(output, "utf8");
  const { exitCode, yolo = false, resolver: requestResolver, ...pipelineOpts } = opts;
  const effectiveCmd = normalizeHead(lastSegment(cmd.startsWith("bash-tool: ") ? cmd.slice(11) : cmd));
  const knownFailure = exitCode != null && exitCode !== 0 && !(exitCode === 1 && EXIT_ONE_IS_FINDINGS.test(unwrapRunner(effectiveCmd) ?? effectiveCmd));
  const resolver = withUserFilters(requestResolver ?? activeResolver ?? defaultResolver);
  let chosen: LoadedFilter | null = null;
  for (const candidate of routingCandidates(cmd)) {
    chosen = await resolver(candidate, allowedSlugs);
    if (chosen) break;
  }
  if (!chosen && rawBytes >= FALLBACK_MIN_BYTES && !TOOL_SYNTHETIC_RE.test(cmd)) {
    chosen = await resolver(`bash-tool: ${cmd}`, allowedSlugs);
  }
  const producer = producingSegment(cmd.startsWith("bash-tool: ") ? cmd.slice(11) : cmd);
  const gitHistory = chosen?.slug === "git-log" && producer != null && /^git\s+log(?:\s|$)/.test(normalizeHead(producer));
  const suspectedFailure = exitCode == null && (gitHistory
    ? /^(?:fatal|error):/im.test(stripAnsi(output))
    : looksLikeFailure(output));
  const targetedRead = chosen?.transform === "smart-read" && rawBytes <= 2_048 &&
    (output.endsWith("\n") ? output.slice(0, -1) : output).split("\n").length <= 60;
  const explicitSlice = rawBytes <= 16_384 && producer != null &&
    /^(?:head|tail)(?:\s|$)|^sed\s+(?:(?:-[Eru]+|--(?:regexp-extended|unbuffered|sandbox))\s+)*(?:-[Enruse]*n[Enruse]*(?:\s|$)|--(?:quiet|silent)(?:\s|$))/.test(normalizeHead(producer));
  const completeLightRead = chosen?.transform === "smart-read" && rawBytes <= 16_384 &&
    (pipelineOpts.verbosity ?? "normal") === "normal" && pipelineOpts.smartCode !== true;
  const editableRead = chosen?.slug === "read-tool" && rawBytes < READ_FOLD_MIN_BYTES;
  if (!yolo && (completeLightRead || editableRead || explicitSlice || (targetedRead && pipelineOpts.smartCode !== true))) {
    return { output, filterId: chosen?.slug ?? null, rawBytes, filteredBytes: rawBytes, debugBypass: knownFailure || suspectedFailure, droppedTail: null };
  }
  if (!yolo && chosen && !chosen.preserve_exact && (knownFailure || suspectedFailure) && TEST_COMMAND_RE.test(effectiveCmd)) {
    const summary = summarizeTestFailures(output, pipelineOpts.verbosity ?? "normal");
    const summaryBytes = summary === null ? rawBytes : Buffer.byteLength(summary, "utf8");
    if (summary !== null && summaryBytes < rawBytes) {
      return { output: summary, filterId: chosen.slug, rawBytes, filteredBytes: summaryBytes, debugBypass: true, droppedTail: output, failureSummary: true };
    }
  }
  if (!chosen || ((knownFailure || suspectedFailure) && chosen.preserve_exact && !yolo)) {
    return { output, filterId: null, rawBytes, filteredBytes: rawBytes, debugBypass: knownFailure || suspectedFailure, ...(yolo ? { droppedTail: null } : {}) };
  }
  const finalize = (result: RunResult): RunResult => {
    if (!yolo) return result;
    const baseline = result.filteredBytes > rawBytes || (rawBytes > 0 && result.output.length === 0) ? output : result.output;
    const compact = !result.debugBypass && !chosen?.preserve_exact
      ? compactStructuredOutput(baseline, "minimal", result.filterId ?? "")
      : baseline;
    const compactExcerpt = yoloExcerpt(compact);
    const excerpt = compactExcerpt === compact ? compact : yoloExcerpt(baseline);
    return { ...result, output: excerpt, filteredBytes: Buffer.byteLength(excerpt, "utf8"), droppedTail: null };
  };
  if (chosen.slug === "tsc" && !knownFailure && !suspectedFailure && !requestsTscListing(cmd)) {
    const collapsed = collapseTscFileList(output);
    if (collapsed !== null) {
      return finalize({ output: collapsed, filterId: chosen.slug, rawBytes, filteredBytes: Buffer.byteLength(collapsed, "utf8"), debugBypass: false, droppedTail: null });
    }
  }
  if (knownFailure || suspectedFailure) {
    let filtered = yolo
      ? applyFilter(output, {
        ...chosen,
        keep_failures: true,
        transform: undefined,
        max_lines: undefined,
        truncate_lines_at: undefined,
        on_empty: undefined
      }, { verbosity: "minimal", smartCode: false })
      : chosen.strip_on_failure && !chosen.preserve_exact
        ? failureStripped(output, chosen, pipelineOpts.verbosity)
        : chosen.strip_ansi && !chosen.preserve_exact ? stripAnsi(output) : output;
    if (!yolo && pipelineOpts.verbosity === "minimal" && chosen.transform !== "smart-read") {
      filtered = compactRepeatedDiagnostics(filtered);
    }
    if (!yolo && chosen.slug === "pytest" && (pipelineOpts.verbosity === "compact" || pipelineOpts.verbosity === "minimal") &&
      /^={3,} test session starts ={3,}\r?$/m.test(filtered) && /^={3,} FAILURES ={3,}\r?$/m.test(filtered)) {
      filtered = filtered.replace(/^([=_])\1{2,} (.+?) \1{3,}(\r?)$/gm, "$2$3");
    }
    const condensed = !yolo && !chosen.preserve_exact && rawBytes >= FAILURE_NOISE_MIN_BYTES
      ? condenseLogNoise(filtered.split("\n")).join("\n")
      : filtered;
    const noiseDropped = condensed.length < filtered.length;
    return finalize({
      output: condensed,
      filterId: chosen.slug,
      rawBytes,
      filteredBytes: Buffer.byteLength(condensed, "utf8"),
      debugBypass: true,
      ...(noiseDropped ? { droppedTail: output } : {})
    });
  }
  const { text, droppedTail } = applyFilterWithTail(output, chosen, yolo
    ? { ...pipelineOpts, verbosity: "minimal", ...(chosen.transform === "smart-read" ? { smartCode: true } : {}) }
    : pipelineOpts);
  const filtered = !yolo && !chosen.preserve_exact
    ? compactStructuredOutput(text, pipelineOpts.verbosity, chosen.slug)
    : text;
  const filteredBytes = Buffer.byteLength(filtered, "utf8");
  if (output.trim().length > 0 && filteredBytes >= rawBytes) {
    return finalize({ output, filterId: chosen.slug, rawBytes, filteredBytes: rawBytes, debugBypass: false, droppedTail: null });
  }
  return finalize({
    output: filtered,
    filterId: chosen.slug,
    rawBytes,
    filteredBytes,
    debugBypass: false,
    droppedTail
  });
}

export { loadFilters, selectFilter, applyFilter, applyFilterWithTail, looksLikeFailure };
export type { LoadedFilter, PipelineOpts };
