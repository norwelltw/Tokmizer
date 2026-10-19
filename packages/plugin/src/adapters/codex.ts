import { processOutput } from "../engine";
import { slugKey } from "../contracts";
import { resolveAllowedFilters } from "../default-rules";
import { readStdin } from "../stdin";
import { loadState } from "../state";
import { graceExceeded } from "../entitlement";
import { loadSettingsCache } from "../settings-cache";
import { recordEvent } from "../learn/recorder";
import { recordTelemetry } from "../learn/telemetry";
import { recordStat, countedSaving, statCmdLabel, statOutcome } from "../stats";
import { hostOutputCapBytes } from "../host-detect";
import { installDaemonResolver, closeDaemonResolver } from "../daemon/resolver";
import { yoloEnabled } from "../yolo-mode";
import { routePreToolUse } from "../hooks-host/hook-router";
import { payloadSignals } from "../hooks-host/payload-host";

export type CodexHookPayload = {
  event: "before_tool_call" | "after_tool_call";
  tool: string;
  command?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
  exit_code?: number;
};

export type CodexHookResponse = {
  action: "continue" | "replace_output";
  replacement?: string;
  reason?: string;
};

const SHELL_TOOLS = new Set([
  "shell",
  "bash",
  "exec",
  "run_shell_command",
  "execute_shell_command"
]);

export async function handleCodexHook(payload: CodexHookPayload): Promise<CodexHookResponse> {
  if (payload.event !== "after_tool_call") return { action: "continue" };
  if (!SHELL_TOOLS.has(payload.tool)) return { action: "continue" };

  const cmd = typeof payload.command === "string" ? payload.command
    : Array.isArray(payload.args) && payload.args.every((a) => typeof a === "string") ? payload.args.join(" ") : "";
  if (!cmd) return { action: "continue" };

  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  const yolo = yoloEnabled();
  if (!stdout && (!yolo || !stderr)) return { action: "continue" };

  const settings = await loadSettingsCache();
  if (!settings.enabled) return { action: "continue" };

  const state = await loadState();
  if (!state || !state.token) return { action: "continue" };

  installDaemonResolver();
  const baseAllowed = resolveAllowedFilters(state.allowedFilters, graceExceeded(state));
  const disabledKeys = new Set(settings.filters.disabled.map(slugKey));
  const allowed = baseAllowed && disabledKeys.size > 0
    ? new Set([...baseAllowed].filter((slug) => !disabledKeys.has(slug)))
    : baseAllowed;
  let result: Awaited<ReturnType<typeof processOutput>>;
  let errResult: Awaited<ReturnType<typeof processOutput>> | null = null;
  try {
    result = await processOutput(cmd, stdout, allowed, {
      verbosity: settings.outputVerbosity,
      yolo,
      exitCode: payload.exit_code
    });
    if (yolo && stderr) {
      errResult = await processOutput(cmd, stderr, allowed, {
        verbosity: settings.outputVerbosity,
        yolo,
        exitCode: payload.exit_code
      });
    }
  } finally {
    closeDaemonResolver();
  }

  const reduced = result.filteredBytes < result.rawBytes || (errResult != null && errResult.filteredBytes < errResult.rawBytes);
  const deliveredErr = errResult?.output ?? stderr;
  const replacement = deliveredErr ? (result.output ? `${result.output}\n${deliveredErr}` : deliveredErr) : result.output;
  const rawBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
  const counted = countedSaving(rawBytes, reduced ? Buffer.byteLength(replacement, "utf8") : rawBytes, hostOutputCapBytes("codex"));
  recordStat(counted.raw, counted.filtered, undefined, false, "codex", "sh", statCmdLabel(cmd), process.cwd(), statOutcome(result));

  await recordEvent({
    cmd,
    filterId: result.filterId,
    rawBytes: result.rawBytes,
    filteredBytes: result.filteredBytes
  });

  await recordTelemetry({
    cmd,
    tokensSaved: Math.max(0, Math.round((counted.raw - counted.filtered) / 4)),
    rawTokens: Math.round(counted.raw / 4),
    optimized: result.filterId != null,
    telemetryOptIn: settings.telemetryOptIn,
    host: "codex"
  });

  if (!reduced) {
    return { action: "continue" };
  }

  return {
    action: "replace_output",
    replacement,
    reason: "tokmizer"
  };
}

const LEGACY_EVENTS = new Set<unknown>(["before_tool_call", "after_tool_call"]);

export async function codexHookResponse(raw: string): Promise<string> {
  const keepGoing = JSON.stringify({ action: "continue" });
  if (!raw) return keepGoing;
  let payload: CodexHookPayload & { hook_event_name?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return keepGoing;
  }
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return keepGoing;
  if (payload.hook_event_name !== undefined || (!LEGACY_EVENTS.has(payload.event) && payloadSignals(payload).length > 0)) return routePreToolUse(payload, "codex");
  try {
    return JSON.stringify(await handleCodexHook(payload));
  } catch (err) {
    process.stderr.write(`tkr-codex: ${(err as Error).message}\n`);
    return keepGoing;
  }
}

export async function runCodexHookFromStdin(): Promise<void> {
  const out = await codexHookResponse(await readStdin());
  if (out) process.stdout.write(out);
}
