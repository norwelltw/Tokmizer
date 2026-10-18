import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../license", () => ({ maybeAutoEnroll: vi.fn(async () => null) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn(async () => ({ enabled: false })) }));

import { runWrapped } from "../exec/wrapper";

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-wrap-sig-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("runWrapped signal listeners", () => {
  it("removes its SIGINT/SIGTERM listeners after each run", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    await runWrapped(["echo", "hi"]);
    await runWrapped(["echo", "hi"]);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
});
