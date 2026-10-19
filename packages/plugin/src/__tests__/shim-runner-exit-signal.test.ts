import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, constants } from "node:os";
import { join } from "node:path";

vi.mock("../state", () => ({ loadState: vi.fn(async () => null) }));
vi.mock("../settings-cache", () => ({
  loadSettingsCache: vi.fn(async () => ({ enabled: false, filters: { disabled: [] }, outputVerbosity: "normal" }))
}));

import { runShim } from "../shim/runner";
import { loadSettingsCache } from "../settings-cache";

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-shim-exitsig-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  rmSync(dir, { recursive: true, force: true });
});

const signals = ["KILL", "ABRT", "HUP", "SEGV", "TERM", "INT"] as const;

describe.runIf(process.platform !== "win32")("runShim signal exit codes", () => {
  for (const name of signals) {
    const expected = 128 + constants.signals[`SIG${name}`];
    it(`maps a child killed by SIG${name} to ${expected}`, async () => {
      const r = await runShim({ cmdName: "sh", args: ["-c", `kill -${name} $$`] });
      expect(r.exitCode).toBe(expected);
    });
  }

  it("maps signals the same way on the unfiltered fallback", async () => {
    vi.mocked(loadSettingsCache).mockRejectedValueOnce(new Error("boom"));
    const r = await runShim({ cmdName: "sh", args: ["-c", "kill -KILL $$"] });
    expect(r.exitCode).toBe(128 + constants.signals.SIGKILL);
  });
});
