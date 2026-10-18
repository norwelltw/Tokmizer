import { existsSync, writeFileSync, appendFileSync, statSync, constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tokmizerHome } from "../paths";
import { loadState } from "../state";
import { detectHost, hostOutputCapBytes } from "../host-detect";
import { recordSessionEvent } from "../session-log";
import { tokmizerEnabled } from "./quick-settings";
import { rememberOutput, repeatNotice } from "../repeat-guard";
import { yoloEnabled } from "../yolo-mode";
import type { FilterResolver } from "../engine";
import { READ_EDIT_NOTICE } from "../engine/read-notice";
import { claudeOrCodex } from "./payload-host";
import { rewrite, splitTopLevel } from "./pre-tool-rewrite";

const COVERED_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MIN_BASH_OUTPUT_BYTES = 1024;
const GLOB_MIN_PATHS = 40;
const PERSISTED_MAX_CHARS = 25_000;

export type PostToolUsePayload = Payload;

type Payload = {
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    pattern?: string;
    path?: string;
    command?: string;
    offset?: number;
    limit?: number;
  };
  tool_response?:
    | {
        content?: string;
        output?: string;
        stdout?: string;
        stderr?: string;
        file?: { content?: string };
        filenames?: string[];
        interrupted?: boolean;
        isImage?: boolean;
        backgroundTaskId?: string;
        returnCodeInterpretation?: string;
        persistedOutputPath?: string;
        persistedOutputSize?: number;
      }
    | string;
};

const OMISSION_MARKER_RE = /^… \(?\d+ more lines omitted\)?$/;
const RESTORE_HINT_RE = /^\[tkr restore [0-9a-f]{8,64}\]$/;
const GROUPED_PATHS_RE = /^\d+F \d+D(?: in .+\/)?:$|^\S.*\/ \(\d+(?:, \*\.[^)]+)?\): \S/;
const READ_OMISSION_RE = /^… \(\d+ more lines omitted\)$/m;

function isAnnotationLine(line: string): boolean {
  return OMISSION_MARKER_RE.test(line) || RESTORE_HINT_RE.test(line) || line === "[YOLO: omitted]";
}

function buildUpdatedToolOutput(resp: Payload["tool_response"], compressed: string, tool?: string): unknown {
  if (!resp || typeof resp === "string") return compressed;
  if (resp.file?.content != null) return { ...resp, file: { ...resp.file, content: compressed } };
  if (resp.content != null) return { ...resp, content: compressed };
  if (resp.output != null) return { ...resp, output: compressed };
  if (resp.stdout != null || resp.stderr != null) {
    const { persistedOutputPath: _path, persistedOutputSize: _size, ...rest } = resp;
    return { ...rest, stdout: compressed, stderr: "" };
  }
  if (Array.isArray(resp.filenames)) {
    const known = new Set(resp.filenames);
    const grouped = tool === "Glob";
    const kept = compressed.split("\n").filter((l) => known.has(l) || isAnnotationLine(l) || (grouped && GROUPED_PATHS_RE.test(l)));
    return { ...resp, filenames: kept };
  }
  return compressed;
}

export function buildHookEnvelope(payload: Payload, compressed: string, systemMessage?: string): string {
  return JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: buildUpdatedToolOutput(payload.tool_response, compressed, payload.tool_name)
    }
  });
}

const FIRST_SAVE_MIN_TOKENS = 100;

let pendingFirstSave: string | null = null;

export function takeFirstSaveNotice(): string | null {
  const notice = pendingFirstSave;
  pendingFirstSave = null;
  return notice;
}

function formatTokens(bytes: number): string {
  const tokens = Math.round(bytes / 4);
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
}

function maybeNoteFirstSave(rawBytes: number, deliveredBytes: number): void {
  try {
    if (Math.round((rawBytes - deliveredBytes) / 4) < FIRST_SAVE_MIN_TOKENS) return;
    const flag = join(tokmizerHome(), "first-save");
    if (existsSync(flag)) return;
    writeFileSync(flag, String(Date.now()));
    pendingFirstSave =
      `Tokmizer just optimized its first command output here: ~${formatTokens(rawBytes)} tokens ` +
      `down to ~${formatTokens(deliveredBytes)}. Watch it add up: /tkr-gain`;
  } catch {}
}

function extractOutput(resp: Payload["tool_response"]): string | null {
  if (!resp) return "";
  if (typeof resp === "string") return resp;
  if (resp.file?.content != null) return resp.file.content;
  if (resp.content != null) return resp.content;
  if (resp.output != null) return resp.output;
  if (resp.stdout != null || resp.stderr != null) {
    return [resp.stdout ?? "", resp.stderr ?? ""].filter(Boolean).join("\n");
  }
  if (Array.isArray(resp.filenames)) return resp.filenames.join("\n");
  return null;
}

const DRIFT_LOG_MAX_BYTES = 64 * 1024;

function recordDrift(tool: string, resp: unknown): void {
  try {
    if (!resp || typeof resp !== "object") return;
    const file = join(tokmizerHome(), "drift.jsonl");
    try {
      if (statSync(file).size > DRIFT_LOG_MAX_BYTES) return;
    } catch {}
    const keys = Object.keys(resp).slice(0, 12);
    appendFileSync(file, `${JSON.stringify({ t: Math.floor(Date.now() / 1000), tool, keys })}\n`);
  } catch {}
}

function pseudoCommand(payload: Payload): string {
  const name = payload.tool_name ?? "tool";
  const input = payload.tool_input ?? {};
  if (input.command) return input.command.split("\n")[0]!.trim().slice(0, 200);
  if (input.file_path) return `${name.toLowerCase()} ${input.file_path}`;
  if (input.pattern) return `${name.toLowerCase()} ${input.pattern}`;
  if (input.path) return `${name.toLowerCase()} ${input.path}`;
  return name.toLowerCase();
}

const EXEC_LAUNCHER_RE = /'(?:[A-Za-z]:)?\/[^']*\/(?:tkr-exec(?:\.exe|\.js)?'|tkr(?:\.exe)?' exec)(?:\\'')?(?:\s|$)/;
const UNKNOWN_STATUS_RE = /;|\|\||\n|(?<![>&|])&(?![&>])/;
const SILENT_HEADS = new Set(["cd", "export", "set", "unset", "true", ":"]);
const SHELL_SCRIPT_RE = /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)\s+-[elux]*c[elux]*\s+'([^']*)'$/;

const BARE_LAUNCHER_RE = /(?:^|[\s;&|(])(?:[A-Za-z]:)?\/\S*\/tkr-exec(?:\.exe|\.js)?\s|(?:^|[;&|(\n])\s*(?:\S*\/)?tkr-exec(?:\.exe|\.js)?\s/;

export function routedThroughExec(cmd: string): boolean {
  return EXEC_LAUNCHER_RE.test(cmd) || BARE_LAUNCHER_RE.test(cmd);
}

function soleProducer(cmd: string, wrapped: string, depth = 0): boolean {
  const segs = splitTopLevel(cmd);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.kind === "sep") continue;
    const text = seg.text.trim();
    if (!text || text === wrapped) continue;
    const next = segs[i + 1];
    if (next?.kind === "sep" && (next.text === "|" || next.text === "|&")) continue;
    if (SILENT_HEADS.has(text.split(/\s+/)[0]!)) continue;
    const script = depth < 3 ? SHELL_SCRIPT_RE.exec(text) : null;
    if (script && soleProducer(script[1]!, wrapped, depth + 1)) continue;
    return false;
  }
  return true;
}

function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let started = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "'") {
      const end = segment.indexOf("'", i + 1);
      if (end === -1) return null;
      word += segment.slice(i + 1, end);
      started = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < segment.length && segment[j] !== '"'; j++) {
        if (segment[j] === "\\" && /["\\$`]/.test(segment[j + 1] ?? "")) j++;
        word += segment[j];
      }
      if (j >= segment.length) return null;
      started = true;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= segment.length) return null;
      word += segment[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words.length > 0 ? words : null;
}

function expands(cmd: string): boolean {
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote === "'") {
      if (c === "'") quote = "";
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$" || c === "`") return true;
    if (c === '"') quote = quote ? "" : '"';
    else if (c === "'" && !quote) quote = "'";
  }
  return false;
}

async function persistedFullOutput(resp: Payload["tool_response"]): Promise<string | null | undefined> {
  if (!resp || typeof resp !== "object" || resp.persistedOutputPath == null) return undefined;
  const { stdout, persistedOutputPath: path, persistedOutputSize: size } = resp;
  if (typeof stdout !== "string" || typeof path !== "string" || typeof size !== "number" || !Number.isFinite(size)) return null;
  if (Buffer.byteLength(stdout, "utf8") >= size || stdout.length >= size) return undefined;
  if (!stdout || (resp.stderr != null && resp.stderr !== "") || resp.interrupted === true || resp.isImage === true) return null;
  if (!isAbsolute(path) || basename(dirname(path)) !== "tool-results") return null;
  try {
    const link = await lstat(path);
    if (!link.isFile() || link.size > MAX_OUTPUT_BYTES) return null;
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > MAX_OUTPUT_BYTES || st.size !== link.size) return null;
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await handle.read(buf, 0, st.size, 0);
      if (bytesRead !== st.size) return null;
      const text = buf.toString("utf8");
      if (buf.length !== size && text.length !== size) return null;
      return text.startsWith(stdout) ? text : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

type ExecEquivalent = { argv: string[]; stdout: string; stderr: string; exitCode: number };

function execEquivalent(cmd: string, resp: Payload["tool_response"]): ExecEquivalent | null {
  if (!resp || typeof resp !== "object" || typeof resp.stdout !== "string") return null;
  if (resp.stderr != null && typeof resp.stderr !== "string") return null;
  if (resp.interrupted === true || resp.isImage === true || resp.backgroundTaskId != null) return null;
  if (UNKNOWN_STATUS_RE.test(cmd) || expands(cmd)) return null;
  const wrapped: string[] = [];
  rewrite(cmd, "tkr-exec", () => true, (segment) => wrapped.push(segment));
  if (wrapped.length !== 1 || expands(wrapped[0]!) || !soleProducer(cmd, wrapped[0]!)) return null;
  if (splitTopLevel(cmd).some((seg) => seg.kind === "sep" && seg.text !== "&&" && seg.text !== "|" && seg.text !== "|&")) return null;
  const argv = shellWords(wrapped[0]!);
  if (!argv) return null;
  return { argv, stdout: resp.stdout, stderr: resp.stderr ?? "", exitCode: resp.returnCodeInterpretation != null ? 1 : 0 };
}

async function processAsExec(run: ExecEquivalent, payload: Payload, yolo: boolean, options: PostToolUseOptions, maxChars?: number): Promise<string | null> {
  const { processCapturedOutput } = await import("../exec/wrapper");
  let held: (() => Promise<void>) | null = null;
  const deferAccounting = (commit: () => Promise<void>): void => { held = commit; };
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (payload.session_id) env.CLAUDE_CODE_SESSION_ID = payload.session_id;
  else delete env.CLAUDE_CODE_SESSION_ID;
  const result = await processCapturedOutput(
    { argv: run.argv, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, truncated: false, stderrTruncated: false },
    {
      yolo,
      env,
      ...(options.resolver ? { resolver: options.resolver } : {}),
      deferAccounting,
      cwd: payload.cwd || (options.inferCwd === false ? undefined : process.cwd())
    }
  );
  const commit = held as (() => Promise<void>) | null;
  const raw = [run.stdout, run.stderr].filter(Boolean).join("\n");
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (maxChars == null && result.filterId != null && payload.session_id && rawBytes >= MIN_BASH_OUTPUT_BYTES) {
    const earlier = rememberOutput(payload.session_id, payload.agent_id ?? "main", raw, (payload.tool_input?.command ?? "").split("\n")[0] ?? "");
    if (earlier) {
      const notice = repeatNotice(earlier.cmd, rawBytes);
      if (yolo) return notice;
      const { captureOriginalForRestore } = await import("./post-tool-deps");
      return captureOriginalForRestore(raw, notice);
    }
  }
  const merged = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const unchanged = result.stdout === run.stdout && result.stderr === run.stderr;
  if (maxChars != null && (unchanged || merged.length > maxChars)) return null;
  if (commit) {
    if (options.deferAccounting) options.deferAccounting(commit);
    else await commit();
  }
  if (unchanged) return null;
  maybeNoteFirstSave(rawBytes, Buffer.byteLength(merged, "utf8"));
  return merged;
}

export type PostToolUseOptions = {
  resolver?: FilterResolver | undefined;
  inferCwd?: boolean;
  deferAccounting?: (commit: () => Promise<void>) => void;
};

function wellFormed(payload: unknown): payload is Payload {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (p.session_id != null && typeof p.session_id !== "string") return false;
  if (p.tool_name != null && typeof p.tool_name !== "string") return false;
  const input = p.tool_input;
  if (input == null) return true;
  if (typeof input !== "object" || Array.isArray(input)) return false;
  const fields = input as Record<string, unknown>;
  return ["command", "file_path", "pattern", "path"].every((k) => fields[k] == null || typeof fields[k] === "string");
}

export async function processToolOutput(payload: Payload, options: PostToolUseOptions = {}): Promise<string | null> {
  if (!wellFormed(payload)) return null;
  const full = payload.tool_name === "Bash" && !routedThroughExec(payload.tool_input?.command ?? "")
    ? await persistedFullOutput(payload.tool_response)
    : undefined;
  if (full === null) return null;
  if (full === undefined) return processPayload(payload, options);
  return processPayload({ ...payload, tool_response: { ...(payload.tool_response as object), stdout: full } }, options, PERSISTED_MAX_CHARS);
}

async function processPayload(payload: Payload, options: PostToolUseOptions, maxChars?: number): Promise<string | null> {
  const yolo = yoloEnabled();
  if (!payload.tool_name || !COVERED_TOOLS.has(payload.tool_name)) return null;
  const shellCmd = payload.tool_name === "Bash" ? payload.tool_input?.command ?? "" : "";
  const wrapped = routedThroughExec(shellCmd);
  if (/\btkr(?:\.js)?\s+restore\b/.test(shellCmd)) return null;
  const state = await loadState();
  if (!tokmizerEnabled()) return null;
  const asExec = payload.tool_name === "Bash" && !wrapped ? execEquivalent(shellCmd, payload.tool_response) : null;
  if (asExec) {
    if (Buffer.byteLength(asExec.stdout, "utf8") + Buffer.byteLength(asExec.stderr, "utf8") > MAX_OUTPUT_BYTES) return null;
    return processAsExec(asExec, payload, yolo, options, maxChars);
  }
  if (payload.session_id && !wrapped && state?.token) {
    const input = payload.tool_input ?? {};
    const target = input.command ?? input.file_path ?? input.pattern ?? input.path ?? "";
    if (target) {
      recordSessionEvent(payload.session_id, {
        tool: payload.tool_name,
        target: target.split("\n")[0]!.trim()
      });
    }
  }
  if (payload.tool_name === "Read" && (payload.tool_input?.offset != null || payload.tool_input?.limit != null)) {
    return null;
  }
  const raw = extractOutput(payload.tool_response);
  if (raw == null) {
    recordDrift(payload.tool_name, payload.tool_response);
    return null;
  }
  if (!raw) return null;
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_OUTPUT_BYTES) return null;
  if (payload.tool_name === "Bash" && bytes < MIN_BASH_OUTPUT_BYTES) return null;
  if (payload.tool_name === "Glob" && raw.split("\n").length < GLOB_MIN_PATHS) return null;
  if (wrapped) return null;
  const {
    loadSettingsCache,
    processOutput,
    captureForRestore,
    captureOriginalForRestore,
    FOLD_MARKER_RE,
    resolveAllowedFilters,
    gatingPlan,
    graceExceeded,
    recordEvent,
    recordTelemetry,
    recordStat,
    countedSaving,
    statCmdLabel,
    statOutcome,
    installDaemonResolver,
    closeDaemonResolver
  } = await import("./post-tool-deps");
  const settings = await loadSettingsCache();
  if (!settings.enabled) return null;
  const { slugKey } = await import("../contracts");
  const plan = state?.token ? gatingPlan(state) : null;
  if (!options.resolver && plan) installDaemonResolver(plan);
  const baseAllowed = state?.token ? resolveAllowedFilters(state.allowedFilters, graceExceeded(state)) : null;
  const disabledKeys = new Set(settings.filters.disabled.map(slugKey));
  const allowed = baseAllowed && disabledKeys.size > 0
    ? new Set([...baseAllowed].filter((slug) => !disabledKeys.has(slug)))
    : baseAllowed;
  const cmd = pseudoCommand(payload);
  const toolSlug = `${payload.tool_name.toLowerCase()}-tool`;
  const synthetic = `${toolSlug}: ${cmd}`;
  try {
    const result = await processOutput(synthetic, raw, allowed, {
      verbosity: settings.outputVerbosity,
      resolver: options.resolver,
      yolo,
      exitCode: payload.tool_name === "Bash" ? undefined : 0
    });
    if (result.filterId != null && payload.tool_name === "Bash" && payload.session_id) {
      const earlier = rememberOutput(payload.session_id, payload.agent_id ?? "main", raw, shellCmd.split("\n")[0] ?? "");
      if (earlier) {
        const notice = repeatNotice(earlier.cmd, bytes);
        return yolo ? notice : await captureOriginalForRestore(raw, notice);
      }
    }
    const foldHint = new RegExp(FOLD_MARKER_RE.source, "m");
    const label = payload.tool_name === "Bash" ? statCmdLabel(payload.tool_input?.command ?? "") : payload.tool_name;
    const partialRead = payload.tool_name === "Read" && !yolo &&
      (foldHint.test(result.output) || READ_OMISSION_RE.test(result.output));
    const shown = partialRead
      ? `${result.output}${result.output.endsWith("\n") ? "" : "\n"}${READ_EDIT_NOTICE}`
      : result.output;
    let output: string | null;
    if (result.filteredBytes >= result.rawBytes) output = null;
    else if (yolo) output = result.output;
    else if (payload.tool_name === "Glob" || foldHint.test(result.output)) output = await captureOriginalForRestore(raw, shown, undefined, { label });
    else output = await captureForRestore(result.droppedTail ?? null, shown, undefined, { raw, label });
    if (yolo && output != null) {
      output = extractOutput(buildUpdatedToolOutput(payload.tool_response, output, payload.tool_name) as Payload["tool_response"]);
    }
    if (maxChars != null && (output == null || output.length > maxChars)) return null;
    const deliveredBytes = output == null ? result.rawBytes : Buffer.byteLength(output, "utf8");
    const host = detectHost().host;
    const counted = countedSaving(result.rawBytes, deliveredBytes, hostOutputCapBytes(host));
    if (output != null) maybeNoteFirstSave(counted.raw, counted.filtered);
    const cwd = payload.cwd || (options.inferCwd === false ? undefined : process.cwd());
    const kind = payload.tool_name === "Bash" ? "sh" : undefined;
    const deferred = options.deferAccounting;
    let recorded = false;
    const account = async (): Promise<void> => {
      if (recorded) return;
      recorded = true;
      await recordEvent({
        cmd: toolSlug,
        filterId: result.filterId,
        rawBytes: result.rawBytes,
        filteredBytes: result.filteredBytes,
        plan
      });
      recordStat(counted.raw, counted.filtered, undefined, false, host, kind, label, cwd, statOutcome(result));
      await recordTelemetry({
        cmd: toolSlug,
        tokensSaved: Math.round((counted.raw - counted.filtered) / 4),
        rawTokens: Math.round(counted.raw / 4),
        optimized: result.filterId != null,
        telemetryOptIn: settings.telemetryOptIn && (!deferred || (await loadSettingsCache()).telemetryOptIn),
        host
      });
    };
    if (deferred) deferred(account);
    else await account();
    return output;
  } finally {
    if (!options.resolver) closeDaemonResolver();
  }
}

export async function postToolUseResponse(payload: Payload, options: PostToolUseOptions = {}): Promise<string> {
  if (claudeOrCodex(payload, "claude-code") !== "claude-code") return "";
  const compressed = await processToolOutput(payload, options);
  if (!compressed) return "";
  return buildHookEnvelope(payload, compressed, takeFirstSaveNotice() ?? undefined);
}
