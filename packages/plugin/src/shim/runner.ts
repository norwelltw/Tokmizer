import spawn from "cross-spawn";
import { processOutput } from "../engine";
import { slugKey } from "../contracts";
import { resolveAllowedFilters } from "../default-rules";
import { loadState } from "../state";
import { gatingPlan, graceExceeded } from "../entitlement";
import { loadSettingsCache } from "../settings-cache";
import { recordEvent } from "../learn/recorder";
import { recordTelemetry } from "../learn/telemetry";
import { recordStat, countedSaving, statCmdLabel, statOutcome } from "../stats";
import { envWithoutShimDir } from "./install";
import { detectHost, hostOutputCapBytes, hasNativeHook } from "../host-detect";
import { installDaemonResolver, closeDaemonResolver } from "../daemon/resolver";
import { captureForRestore, captureOriginalForRestore, neutralizeMarkers } from "../content-cache";
import { FOLD_MARKER_RE } from "../engine/transforms/smart-code";
import { yoloEnabled } from "../yolo-mode";
import { failOpenActive } from "./sh";

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_STREAM_AFTER_MS = 1_500;

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const LONG_RUNNING_SCRIPTS = new Set(["dev", "start", "serve", "preview", "watch"]);

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function resolveStreamAfterMs(): number {
  return envMs(
    "TOKMIZER_SHIM_STREAM_AFTER_MS",
    process.stdout.isTTY ? DEFAULT_STREAM_AFTER_MS : 0
  );
}

export function isLongRunningInvocation(cmdName: string, args: string[]): boolean {
  const base = cmdName.split(/[\\/]/).pop() ?? cmdName;
  if (!PACKAGE_MANAGERS.has(base)) return false;
  return args.some((a) => !a.startsWith("-") && LONG_RUNNING_SCRIPTS.has(a));
}

export type ShimResult = {
  exitCode: number;
  filteredOut: string;
  filteredErr: string;
  filterId: string | null;
  rawBytes: number;
  filteredBytes: number;
};

export type ShimInvocation = {
  cmdName: string;
  args: string[];
};

export function parseShimInvocation(argv: string[]): ShimInvocation {
  if (argv[0] === "--as" && typeof argv[1] === "string") {
    return { cmdName: argv[1], args: argv.slice(2) };
  }
  if (argv.length > 0) {
    return { cmdName: argv[0]!, args: argv.slice(1) };
  }
  return { cmdName: "", args: [] };
}

type Prepared = {
  yolo: boolean;
  settings: Awaited<ReturnType<typeof loadSettingsCache>>;
  state: Awaited<ReturnType<typeof loadState>>;
  plan: ReturnType<typeof gatingPlan> | null;
  allowed: Set<string> | null;
  host: ReturnType<typeof detectHost>["host"];
  piped: boolean;
  bypass: boolean;
  passthrough: boolean;
};

async function prepareShim(cmdName: string, args: string[]): Promise<Prepared> {
  const yolo = yoloEnabled();
  const settings = await loadSettingsCache();
  const state = await loadState();
  const plan = state ? gatingPlan(state) : null;
  const baseAllowed = state
    ? resolveAllowedFilters(state.allowedFilters, graceExceeded(state))
    : new Set<string>();
  const disabledKeys = new Set(settings.filters.disabled.map(slugKey));
  const allowed = baseAllowed && disabledKeys.size > 0
    ? new Set([...baseAllowed].filter((s) => !disabledKeys.has(s)))
    : baseAllowed;
  const host = detectHost().host;
  const piped = !process.stdout.isTTY && host === "shell";
  const bypass = !settings.enabled || !state || hasNativeHook(host) || failOpenActive();
  const passthrough = isLongRunningInvocation(cmdName, args);
  return { yolo, settings, state, plan, allowed, host, piped, bypass, passthrough };
}

function runUnfiltered(cmdName: string, args: string[]): Promise<ShimResult> {
  return new Promise((resolve) => {
    const done = (exitCode: number): void => resolve({ exitCode, filteredOut: "", filteredErr: "", filterId: null, rawBytes: 0, filteredBytes: 0 });
    const child = spawn(cmdName, args, { stdio: "inherit", shell: false, windowsHide: true, env: envWithoutShimDir() });
    child.on("error", (err) => {
      process.stderr.write(`tkr-shim: ${err.message}\n`);
      done(127);
    });
    child.on("close", (code, signal) => done(typeof code === "number" ? code : signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
  });
}

export async function runShim(invocation: ShimInvocation): Promise<ShimResult> {
  const { cmdName, args } = invocation;
  if (!cmdName) {
    process.stderr.write("tkr-shim: missing command name\n");
    return {
      exitCode: 2,
      filteredOut: "",
      filteredErr: "",
      filterId: null,
      rawBytes: 0,
      filteredBytes: 0
    };
  }

  const cmdLine = [cmdName, ...args].join(" ");
  let prepared: Prepared;
  try {
    prepared = await prepareShim(cmdName, args);
  } catch {
    return runUnfiltered(cmdName, args);
  }
  const { yolo, settings, state, plan, allowed, host, piped, bypass, passthrough } = prepared;
  if (state && !bypass && !piped && !passthrough) installDaemonResolver(plan!);

  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  try {
    return await new Promise<ShimResult>((resolve) => {
    const child = spawn(cmdName, args, {
      stdio: passthrough ? "inherit" : ["inherit", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: envWithoutShimDir()
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflowed = false;
    let streaming = passthrough;

    const timeoutMs = envMs("TOKMIZER_SHIM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    const streamAfterMs = resolveStreamAfterMs();
    let killTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (killTimer) clearTimeout(killTimer);
      if (idleTimer) clearTimeout(idleTimer);
      killTimer = undefined;
      idleTimer = undefined;
    };

    const startStreaming = (): void => {
      if (streaming) return;
      streaming = true;
      if (killTimer) clearTimeout(killTimer);
      killTimer = undefined;
      for (const c of outChunks) process.stdout.write(c);
      for (const c of errChunks) process.stderr.write(c);
      outChunks.length = 0;
      errChunks.length = 0;
    };

    const armIdle = (): void => {
      if (streaming || streamAfterMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(startStreaming, streamAfterMs);
      idleTimer.unref?.();
    };

    if (!streaming && timeoutMs > 0) {
      killTimer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      killTimer.unref?.();
    }
    armIdle();

    const forward = (sig: NodeJS.Signals): void => {
      try {
        child.kill(sig);
      } catch {}
    };
    onSigint = (): void => forward("SIGINT");
    onSigterm = (): void => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (streaming) {
        process.stdout.write(chunk);
        return;
      }
      if (outBytes > MAX_BUFFER_BYTES) {
        if (!overflowed) {
          for (const c of outChunks) process.stdout.write(c);
          outChunks.length = 0;
          overflowed = true;
        }
        process.stdout.write(chunk);
        return;
      }
      outChunks.push(chunk);
      armIdle();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (streaming) {
        process.stderr.write(chunk);
        return;
      }
      if (errBytes > MAX_BUFFER_BYTES) {
        if (!overflowed) {
          for (const c of errChunks) process.stderr.write(c);
          errChunks.length = 0;
          overflowed = true;
        }
        process.stderr.write(chunk);
        return;
      }
      errChunks.push(chunk);
      armIdle();
    });

    child.on("error", (err) => {
      clearTimers();
      process.stderr.write(`tkr-shim: ${err.message}\n`);
      resolve({
        exitCode: 127,
        filteredOut: "",
        filteredErr: "",
        filterId: null,
        rawBytes: 0,
        filteredBytes: 0
      });
    });

    child.on("close", async (code, signal) => {
      clearTimers();
      const exitCode =
        typeof code === "number"
          ? code
          : signal === "SIGTERM"
            ? 143
            : signal === "SIGINT"
              ? 130
              : 1;

      const outRaw = Buffer.concat(outChunks);
      const errRaw = Buffer.concat(errChunks);

      if (overflowed || streaming || bypass || piped) {
        if (outRaw.length) process.stdout.write(outRaw);
        if (errRaw.length) process.stderr.write(errRaw);
        resolve({
          exitCode,
          filteredOut: outRaw.toString("utf8"),
          filteredErr: errRaw.toString("utf8"),
          filterId: null,
          rawBytes: outBytes + errBytes,
          filteredBytes: outBytes + errBytes
        });
        return;
      }

      const outBuf = outRaw.toString("utf8");
      const errBuf = errRaw.toString("utf8");

      try {
        const res = await processOutput(cmdLine, outBuf, allowed, {
          verbosity: settings.outputVerbosity,
          yolo,
          exitCode
        });
        const errCandidate = errBuf && (yolo || (exitCode !== 0 && Buffer.byteLength(errBuf, "utf8") >= 1024)) ? await processOutput(cmdLine, errBuf, allowed, {
          verbosity: settings.outputVerbosity,
          yolo,
          exitCode
        }) : null;
        const errRes = errCandidate && (yolo || errCandidate.failureSummary) ? errCandidate : null;
        const stdoutReduced = res.filteredBytes < res.rawBytes;
        const reduced = stdoutReduced || (errRes != null && errRes.filteredBytes < errRes.rawBytes);
        let deliveredErr = neutralizeMarkers(errRes?.output ?? errBuf, errBuf);
        if (errRes && !yolo) {
          try {
            deliveredErr = await captureForRestore(errRes.droppedTail ?? null, errRes.output);
          } catch {}
        }
        let delivered = neutralizeMarkers(stdoutReduced ? res.output : outBuf, outBuf);
        if (stdoutReduced && !yolo) {
          try {
            delivered = new RegExp(FOLD_MARKER_RE.source, "m").test(res.output)
              ? await captureOriginalForRestore(outBuf, res.output, process.env, { label: statCmdLabel(cmdLine) })
              : await captureForRestore(res.droppedTail ?? null, res.output, process.env, { raw: outBuf, label: statCmdLabel(cmdLine) });
          } catch {}
        }
        const rawBytes = outRaw.length + errRaw.length;
        const counted = countedSaving(
          rawBytes,
          reduced ? Buffer.byteLength(delivered, "utf8") + Buffer.byteLength(deliveredErr, "utf8") : rawBytes,
          hostOutputCapBytes(host)
        );
        recordStat(counted.raw, counted.filtered, undefined, false, host, "sh", statCmdLabel(cmdLine), process.cwd(), statOutcome(res));
        try {
          await recordEvent({
            cmd: cmdLine,
            filterId: res.filterId,
            rawBytes: res.rawBytes,
            filteredBytes: res.filteredBytes,
            plan: plan!
          });
          await recordTelemetry({
            cmd: cmdLine,
            tokensSaved: Math.max(0, Math.round((counted.raw - counted.filtered) / 4)),
            rawTokens: Math.round(counted.raw / 4),
            optimized: res.filterId != null,
            telemetryOptIn: settings.telemetryOptIn,
            sessionId: process.env.CLAUDE_CODE_SESSION_ID,
            host
          });
        } catch {}
        if (reduced || delivered !== outBuf || deliveredErr !== errBuf) {
          process.stdout.write(delivered);
          if (deliveredErr) process.stderr.write(deliveredErr);
          resolve({
            exitCode,
            filteredOut: delivered,
            filteredErr: deliveredErr,
            filterId: res.filterId,
            rawBytes: res.rawBytes,
            filteredBytes: res.filteredBytes
          });
          return;
        }
      } catch {}

      if (outRaw.length) process.stdout.write(outRaw);
      if (errRaw.length) process.stderr.write(errRaw);
      resolve({
        exitCode,
        filteredOut: outBuf,
        filteredErr: errBuf,
        filterId: null,
        rawBytes: outBytes + errBytes,
        filteredBytes: outBytes + errBytes
      });
    });
    });
  } finally {
    if (onSigint) process.off("SIGINT", onSigint);
    if (onSigterm) process.off("SIGTERM", onSigterm);
    closeDaemonResolver();
  }
}
