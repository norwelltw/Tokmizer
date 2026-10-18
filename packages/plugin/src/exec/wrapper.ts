import spawn from "cross-spawn";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { processOutput, type FilterResolver } from "../engine";
import { slugKey } from "../contracts";
import { resolveAllowedFilters } from "../default-rules";
import { loadState } from "../state";
import { tokmizerHome } from "../paths";
import { gatingPlan, graceExceeded } from "../entitlement";
import { recordEvent } from "../learn/recorder";
import { recordTelemetry } from "../learn/telemetry";
import { recordStat, countedSaving, statCmdLabel, statOutcome } from "../stats";
import { recordSessionEvent } from "../session-log";
import { loadSettingsCache } from "../settings-cache";
import { detectHost, hostOutputCapBytes } from "../host-detect";
import { envWithoutShimDir } from "../shim/install";
import { installDaemonResolver, closeDaemonResolver } from "../daemon/resolver";
import { captureForRestore, captureOriginalForRestore } from "../content-cache";
import { FOLD_MARKER_RE } from "../engine/transforms/smart-code";
import { READ_EDIT_NOTICE } from "../engine/read-notice";
import { normalizeHead, producingSegment } from "../engine/routing";
import { yoloEnabled } from "../yolo-mode";
import { selfInvocation, singleBinary } from "../self-command";
import { networkEnabled } from "../network";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MIN_STDERR_FILTER_BYTES = 1024;
const ENROLL_KICK_THROTTLE_MS = 60_000;
export const CAPTURING_ENV = "TOKMIZER_EXEC_CAPTURING";

export function underCapturingExec(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CAPTURING_ENV] === "1";
}

function decodeBuffered(chunks: Buffer[], truncated: boolean): string {
  const decoder = new StringDecoder("utf8");
  const text = decoder.write(Buffer.concat(chunks));
  return truncated ? text : text + decoder.end();
}

export function kickBackgroundEnroll(): void {
  try {
    if (!networkEnabled()) return;
    const tkrBin = process.env.TOKMIZER_TKR_BIN || fileURLToPath(new URL("../bin/tkr.js", import.meta.url));
    if (!singleBinary() && !existsSync(tkrBin)) return;
    const marker = join(tokmizerHome(), "enroll-kick");
    try {
      const last = Number(readFileSync(marker, "utf8"));
      if (Number.isFinite(last) && Date.now() - last < ENROLL_KICK_THROTTLE_MS) return;
    } catch {}
    mkdirSync(tokmizerHome(), { recursive: true });
    writeFileSync(marker, String(Date.now()));
    const [command, ...args] = selfInvocation(tkrBin);
    const child = spawn(command!, [...args, "heartbeat"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {}
}
export function resolveExecTimeoutMs(env: Record<string, string | undefined>): number {
  const explicit = Number(env.TOKMIZER_EXEC_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const host = Number(env.BASH_MAX_TIMEOUT_MS);
  if (Number.isFinite(host) && host > 600000) return host;
  return 600000;
}

const DEFAULT_TIMEOUT_MS = resolveExecTimeoutMs(process.env);

const SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7,
  SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13,
  SIGALRM: 14, SIGTERM: 15
};
export function signalNumber(sig: string): number {
  return SIGNALS[sig] ?? 15;
}

function readsFile(cmdLine: string): boolean {
  const segment = producingSegment(cmdLine);
  if (segment === null) return false;
  const [head, ...args] = normalizeHead(segment).split(/\s+/);
  return /^(?:cat|head|nl)(?:\.exe)?$/i.test(head?.split(/[\\/]/).pop() ?? "") && args.some((arg) => arg !== "" && !arg.startsWith("-"));
}

export type WrapResult = {
  stdout: string;
  stderr: string;
  code: number;
  filterId: string | null;
  rawBytes: number;
  filteredBytes: number;
  truncated: boolean;
};

export async function runWrapped(argv: string[]): Promise<WrapResult> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("tkr-exec: missing command");
  const yolo = yoloEnabled();

  const child = spawn(cmd, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...envWithoutShimDir(), [CAPTURING_ENV]: "1" }
  });

  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
  });
  const forward = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig);
    } catch {}
  };
  const onSigint = (): void => forward("SIGINT");
  const onSigterm = (): void => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let stderrTruncated = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutBytes >= MAX_BUFFER_BYTES) {
      truncated = true;
      return;
    }
    const remaining = MAX_BUFFER_BYTES - stdoutBytes;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    stdoutChunks.push(slice);
    stdoutBytes += slice.length;
    if (chunk.length > remaining) truncated = true;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_BUFFER_BYTES) {
      stderrTruncated = true;
      return;
    }
    const remaining = MAX_BUFFER_BYTES - stderrBytes;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    stderrChunks.push(slice);
    stderrBytes += slice.length;
    if (chunk.length > remaining) stderrTruncated = true;
  });

  let killTimer: NodeJS.Timeout | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", (err) => {
        if (killTimer) clearTimeout(killTimer);
        if (spawned) {
          resolve(1);
        } else {
          reject(err);
        }
      });
      child.on("close", (c, signal) => {
        if (killTimer) clearTimeout(killTimer);
        resolve(c != null ? c : signal ? 128 + signalNumber(signal) : 0);
      });
      killTimer = setTimeout(() => {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, DEFAULT_TIMEOUT_MS);
      killTimer.unref?.();
    });
  } finally {
    if (killTimer) clearTimeout(killTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  const stdout = decodeBuffered(stdoutChunks, truncated);
  const stderr = decodeBuffered(stderrChunks, stderrTruncated);

  return processCapturedOutput({ argv, stdout, stderr, exitCode, truncated, stderrTruncated }, {
    yolo,
    env: process.env,
    onMissingState: kickBackgroundEnroll
  });
}

export type CapturedOutput = {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  stderrTruncated: boolean;
};

export type CapturedContext = {
  yolo: boolean;
  env: NodeJS.ProcessEnv;
  resolver?: FilterResolver;
  onMissingState?: () => void;
  deferAccounting?: (commit: () => Promise<void>) => void;
  cwd?: string | undefined;
};

export async function processCapturedOutput(
  { argv, stdout, stderr, exitCode, truncated, stderrTruncated }: CapturedOutput,
  { yolo, env, resolver, onMissingState, deferAccounting, ...context }: CapturedContext
): Promise<WrapResult> {

  const truncMarker = truncated ? `\n… (output truncated at ${MAX_BUFFER_BYTES / (1024 * 1024)}MB)` : "";
  const stderrTruncMarker = stderrTruncated ? `\n… (stderr truncated at ${MAX_BUFFER_BYTES / (1024 * 1024)}MB)` : "";

  const rawResult = (): WrapResult => {
    const out = stdout + truncMarker;
    const bytes = Buffer.byteLength(out, "utf8");
    return { stdout: out, stderr: stderr + stderrTruncMarker, code: exitCode, filterId: null, rawBytes: bytes, filteredBytes: bytes, truncated };
  };

  try {
    const state = await loadState();
    if (!state) onMissingState?.();
    const settings = await loadSettingsCache();
    if (!settings.enabled) return rawResult();
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    if (sessionId && state?.token) {
      recordSessionEvent(sessionId, {
        tool: "Bash",
        target: argv.join(" "),
        ...(exitCode !== 0 ? { fail: 1 as const } : {})
      });
    }
    const plan = state ? gatingPlan(state) : null;
    const baseAllowed = state ? resolveAllowedFilters(state.allowedFilters, graceExceeded(state)) : null;
    const disabledKeys = new Set(settings.filters.disabled.map(slugKey));
    const allowed = baseAllowed && disabledKeys.size > 0
      ? new Set([...baseAllowed].filter((s) => !disabledKeys.has(s)))
      : baseAllowed;
    const cmdLine = argv.join(" ");
    if (state && !resolver) installDaemonResolver(plan!);
    const processed = await processOutput(cmdLine, stdout, allowed, {
      verbosity: settings.outputVerbosity,
      resolver,
      yolo,
      exitCode
    });
    let stderrOut = stderr;
    let stderrRawBytes = 0;
    let stderrFilteredBytes = 0;
    if ((yolo || exitCode === 0) && Buffer.byteLength(stderr, "utf8") >= (yolo ? 1 : MIN_STDERR_FILTER_BYTES)) {
      const errProcessed = await processOutput(cmdLine, stderr, allowed, {
        verbosity: settings.outputVerbosity,
        resolver,
        yolo,
        exitCode
      });
      stderrOut = errProcessed.output;
      if (!yolo && errProcessed.output !== stderr) {
        try {
          stderrOut = await captureForRestore(errProcessed.droppedTail ?? null, errProcessed.output, env, { raw: stderrTruncated ? null : stderr, label: statCmdLabel(cmdLine) });
        } catch {}
      }
      stderrRawBytes = errProcessed.rawBytes;
      stderrFilteredBytes = errProcessed.filteredBytes;
    } else if (!yolo && exitCode !== 0 && Buffer.byteLength(stderr, "utf8") >= MIN_STDERR_FILTER_BYTES) {
      const errProcessed = await processOutput(cmdLine, stderr, allowed, {
        verbosity: settings.outputVerbosity,
        resolver,
        exitCode
      });
      if (errProcessed.failureSummary) {
        try {
          stderrOut = await captureForRestore(errProcessed.droppedTail ?? null, errProcessed.output, env);
        } catch {
          stderrOut = errProcessed.output;
        }
        stderrRawBytes = errProcessed.rawBytes;
        stderrFilteredBytes = errProcessed.filteredBytes;
      }
    }

    const partialRead = !yolo && processed.output !== stdout && readsFile(cmdLine);
    const shown = partialRead
      ? `${processed.output}${processed.output.endsWith("\n") ? "" : "\n"}${READ_EDIT_NOTICE}`
      : processed.output;
    let delivered = shown;
    if (!yolo && processed.filteredBytes < processed.rawBytes) {
      try {
        delivered = new RegExp(FOLD_MARKER_RE.source, "m").test(processed.output)
          ? await captureOriginalForRestore(stdout, shown, env, { label: statCmdLabel(cmdLine) })
          : await captureForRestore(processed.droppedTail ?? null, shown, env, { raw: truncated ? null : stdout, label: statCmdLabel(cmdLine) });
      } catch {}
    }
    const deliveredStdout = delivered + truncMarker;
    const deliveredStderr = stderrOut + stderrTruncMarker;
    const host = detectHost(env).host;
    const counted = countedSaving(
      processed.rawBytes + Buffer.byteLength(stderr, "utf8"),
      Buffer.byteLength(deliveredStdout, "utf8") + Buffer.byteLength(deliveredStderr, "utf8"),
      hostOutputCapBytes(host)
    );

    let recorded = false;
    const account = async (): Promise<void> => {
      if (recorded) return;
      recorded = true;
      try {
        recordStat(counted.raw, counted.filtered, undefined, false, host, "sh", statCmdLabel(cmdLine), "cwd" in context ? context.cwd : process.cwd(), statOutcome(processed));

        await recordEvent({
          cmd: cmdLine,
          filterId: processed.filterId,
          rawBytes: processed.rawBytes,
          filteredBytes: processed.filteredBytes,
          plan
        });

        await recordTelemetry({
          cmd: cmdLine,
          tokensSaved: Math.max(0, Math.round((counted.raw - counted.filtered) / 4)),
          rawTokens: Math.round(counted.raw / 4),
          optimized: processed.filterId != null,
          telemetryOptIn: settings.telemetryOptIn && (!deferAccounting || (await loadSettingsCache()).telemetryOptIn),
          sessionId,
          host
        });
      } catch {}
    };
    if (deferAccounting) deferAccounting(account);
    else await account();

    return {
      stdout: deliveredStdout,
      stderr: deliveredStderr,
      code: exitCode,
      filterId: processed.filterId,
      rawBytes: processed.rawBytes + stderrRawBytes,
      filteredBytes: processed.filteredBytes + stderrFilteredBytes,
      truncated
    };
  } catch {
    return rawResult();
  } finally {
    if (!resolver) closeDaemonResolver();
  }
}
