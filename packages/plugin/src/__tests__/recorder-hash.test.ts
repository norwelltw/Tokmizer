import { beforeEach, describe, expect, it } from "vitest";
import { recordEvent } from "../learn/recorder";
import { drainSpool, commitSpool } from "../learn/spool";
import { slugKey } from "../contracts";
import { loadSettingsCache, saveSettingsCache } from "../settings-cache";

beforeEach(async () => {
  await saveSettingsCache({ ...(await loadSettingsCache()), telemetryOptIn: true });
});

describe("learn recorder anti-RE", () => {
  it("does not queue learning events after telemetry is disabled", async () => {
    const settings = await loadSettingsCache();
    await saveSettingsCache({ ...settings, telemetryOptIn: false });
    try {
      commitSpool("learn");
      await recordEvent({ cmd: "ls", filterId: null, rawBytes: 5, filteredBytes: 5 });
      expect(drainSpool("learn")).toEqual([]);
    } finally {
      await saveSettingsCache(settings);
      commitSpool("learn");
    }
  });
  it("spools an opaque filter key, never the raw filter slug", async () => {
    commitSpool("learn");
    await recordEvent({
      cmd: "ls -la /tmp",
      filterId: "ls",
      rawBytes: 100,
      filteredBytes: 40,
      plan: "pro"
    });
    const events = drainSpool("learn") as Array<{ filterId: string | null }>;
    commitSpool("learn");
    expect(events).toHaveLength(1);
    expect(events[0]!.filterId).toBe(slugKey("ls"));
    expect(events[0]!.filterId).not.toBe("ls");
  });

  it("keeps a null filterId null", async () => {
    commitSpool("learn");
    await recordEvent({ cmd: "ls", filterId: null, rawBytes: 5, filteredBytes: 5 });
    const events = drainSpool("learn") as Array<{ filterId: string | null }>;
    commitSpool("learn");
    expect(events).toHaveLength(1);
    expect(events[0]!.filterId).toBeNull();
  });
});
