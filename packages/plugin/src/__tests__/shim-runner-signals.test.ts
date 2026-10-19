import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../state", () => ({ loadState: vi.fn(async () => null) }));
vi.mock("../settings-cache", () => ({
  loadSettingsCache: vi.fn(async () => ({ enabled: false, filters: { disabled: [] }, outputVerbosity: "normal" }))
}));

import { runShim } from "../shim/runner";

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-shim-sig-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("runShim signal listeners", () => {
  it("removes its SIGINT/SIGTERM listeners after each run", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    await runShim({ cmdName: "echo", args: ["hi"] });
    await runShim({ cmdName: "echo", args: ["hi"] });
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it.skipIf(process.platform === "win32")("passes a hangup on to the command instead of leaving it orphaned", async () => {
    const run = runShim({ cmdName: "sleep", args: ["30"] });
    await new Promise((r) => setTimeout(r, 200));
    process.emit("SIGHUP", "SIGHUP");
    const started = Date.now();
    const result = await run;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).toBe(129);
    expect(process.listenerCount("SIGHUP")).toBe(0);
  });
});
