import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTextPreserving } from "../hook-config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-cfg-write-"));
});

afterEach(() => {
  try {
    chmodSync(join(dir, "hooks.json"), 0o600);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("writing an agent configuration file", () => {
  it("leaves a file the user made read-only untouched", async () => {
    const file = join(dir, "hooks.json");
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o444);
    expect(await writeTextPreserving(file, "{\"hooks\":1}\n")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{}\n");
  });

  it("still writes through a link whose target exists", async () => {
    const real = join(dir, "real.json");
    writeFileSync(real, "{}\n");
    symlinkSync(real, join(dir, "hooks.json"));
    expect(await writeTextPreserving(join(dir, "hooks.json"), "{\"a\":1}\n")).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("{\"a\":1}\n");
  });
});
