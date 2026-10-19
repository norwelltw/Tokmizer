import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let previousHome: string | undefined;
let previousUmask: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tkr-home-perm-"));
  previousHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = join(root, ".tokmizer");
  previousUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(previousUmask);
  if (previousHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe.skipIf(process.platform === "win32")("~/.tokmizer stays private", () => {
  it("is created owner-only when the state is first saved", async () => {
    const { saveState } = await import("../state");
    await saveState({ token: null } as never);
    expect(mode(process.env.TOKMIZER_HOME!)).toBe(0o700);
  });

  it("is created owner-only by the bundle cache and the settings cache", async () => {
    const { saveBundleCache } = await import("../daemon/bundle-cache");
    saveBundleCache({ payload: "p", signature: "s", enc: "v1" });
    expect(mode(process.env.TOKMIZER_HOME!)).toBe(0o700);
    rmSync(process.env.TOKMIZER_HOME!, { recursive: true, force: true });
    const { saveSettingsCache } = await import("../settings-cache");
    await saveSettingsCache({} as never);
    expect(mode(process.env.TOKMIZER_HOME!)).toBe(0o700);
  });
});
