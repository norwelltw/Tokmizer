#!/usr/bin/env node
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { reducerConfigured } from "./quick-settings";

const FACTOR: Record<string, number> = { light: 0.25, balanced: 0.45, max: 0.7 };
const TAIL_BYTES = 256 * 1024;
const MAX_SAVED_PER_TURN = 2000;
const MIN_SAVED = 5;

function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function lastAssistantTextChars(transcript: string): number {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"assistant"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      let chars = 0;
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          chars += block.text.length;
        }
      }
      return chars;
    } catch {
      continue;
    }
  }
  return 0;
}

async function main(): Promise<void> {
  if (!reducerConfigured()) return;
  const { loadSettingsCache } = await import("../settings-cache");
  const { readSkill } = await import("../cache");
  const { reducerStillEntitled } = await import("./reducer-gate");
  const { recordTelemetry } = await import("../learn/telemetry");
  const { recordStat } = await import("../stats");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string" || !transcriptPath) return;

  const settings = await loadSettingsCache();
  if (!settings.enabled) return;
  const factor = FACTOR[settings.reducer];
  if (!factor) return;
  if (!(await reducerStillEntitled())) return;
  if (!(await readSkill(`reducer-${settings.reducer}`))) return;

  const chars = lastAssistantTextChars(readTail(transcriptPath));
  if (chars <= 0) return;
  const emitted = Math.ceil(chars / 4);
  const saved = Math.min(MAX_SAVED_PER_TURN, Math.round((emitted * factor) / (1 - factor)));
  if (saved < MIN_SAVED) return;

  recordStat((emitted + saved) * 4, emitted * 4, undefined, true, "claude-code", undefined, undefined, typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd());

  await recordTelemetry({
    cmd: "reducer",
    tokensSaved: saved,
    optimized: true,
    telemetryOptIn: settings.telemetryOptIn,
    sessionId: payload.session_id,
    host: "claude-code"
  });
}

main().catch(() => {});
