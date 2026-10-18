import { commandName } from "./telemetry";
import { redactCommand } from "./redact";
import { appendSpool, uploadSpool, type UploadResult } from "./spool";
import { slugKey, type Plan } from "../contracts";
import { isUserFilterId } from "../engine/user-filters";
import { loadSettingsCache } from "../settings-cache";

type Buffered = {
  cmd: string;
  filterId: string | null;
  rawBytes: number;
  filteredBytes: number;
};

export type RecordInput = Buffered & { plan: Plan | null };

export async function recordEvent(input: RecordInput): Promise<void> {
  if (input.plan !== "pro") return;
  if (isUserFilterId(input.filterId)) return;
  if (!(await loadSettingsCache()).telemetryOptIn) return;
  const name = commandName(input.cmd);
  if (!name || redactCommand(name) !== name) return;
  appendSpool("learn", {
    cmd: name,
    filterId: input.filterId == null ? null : slugKey(input.filterId),
    rawBytes: input.rawBytes,
    filteredBytes: input.filteredBytes
  });
}

export async function flush(baseUrl?: string): Promise<UploadResult> {
  return uploadSpool("learn", "/api/v1/learn", { baseUrl, requirePro: true, consent: true });
}
