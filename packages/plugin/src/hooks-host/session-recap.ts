import { readStdin } from "../stdin";
import { isEntryModule } from "../entry";
import { readSessionEvents, buildSessionRecap, pruneSessions } from "../session-log";
import { forgetSession } from "../repeat-guard";
import { telemetryNoticeLine } from "../telemetry-hint";
import { codexHookNoticeLine } from "../codex-hook-notice";

type SessionStartPayload = {
  session_id?: string;
  source?: string;
};

export async function recapForSessionStart(payload: SessionStartPayload): Promise<string | null> {
  if (payload.source !== "compact" && payload.source !== "resume") return null;
  if (!payload.session_id) return null;
  const events = readSessionEvents(payload.session_id);
  const recap = buildSessionRecap(events);
  return recap || null;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw) process.exit(0);
  let payload: SessionStartPayload;
  try {
    payload = JSON.parse(raw) as SessionStartPayload;
  } catch {
    process.exit(0);
  }
  const notices = [await telemetryNoticeLine().catch(() => null), codexHookNoticeLine()].filter((n): n is string => n !== null);
  const output = sessionStartOutput(await handleSessionStart(payload), notices.length ? notices.join("\n") : null);
  if (output) process.stdout.write(output);
}

export function sessionStartOutput(recap: string | null, notice: string | null): string | null {
  if (!notice) return recap;
  return JSON.stringify({
    systemMessage: notice,
    ...(recap ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: recap } } : {})
  });
}

export async function handleSessionStart(payload: SessionStartPayload): Promise<string | null> {
  try {
    pruneSessions();
  } catch {}
  if (payload.session_id && payload.source !== "startup") forgetSession(payload.session_id);
  return recapForSessionStart(payload);
}

const entry = process.argv[1] ?? "";
if (isEntryModule(entry, import.meta.url, "session-recap")) {
  main().catch(() => {
    process.exit(0);
  });
}
