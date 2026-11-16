import { commandName, isKnownProgram } from "./telemetry";
import { redactCommand } from "./redact";
import { appendSpool, uploadSpool, type UploadResult } from "./spool";
import { slugKey } from "../contracts";
import { isUserFilterId } from "../engine/user-filters";
import { loadSettingsCache } from "../settings-cache";

export type RecordInput = {
  cmd: string;
  filterId: string | null;
  rawBytes: number;
  filteredBytes: number;
};

export async function recordEvent(input: RecordInput): Promise<void> {
  if (isUserFilterId(input.filterId)) return;
  if (!(await loadSettingsCache()).telemetryOptIn) return;
  const name = commandName(input.cmd);
  if (!name || redactCommand(name) !== name) return;
  appendSpool("learn", {
    // Same rule as usage stats: a program outside the public catalog (an in-house tool name) is never sent.
    cmd: isKnownProgram(name) ? name : "other",
    filterId: input.filterId == null ? null : slugKey(input.filterId),
    rawBytes: input.rawBytes,
    filteredBytes: input.filteredBytes
  });
}

export async function flush(baseUrl?: string): Promise<UploadResult> {
  return uploadSpool("learn", "/api/v1/learn", { baseUrl, consent: true });
}
