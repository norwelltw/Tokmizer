import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: () => {} })));
vi.mock("cross-spawn", () => ({ default: spawnMock }));

import { kickBackgroundEnroll } from "../exec/wrapper";

let home: string;
const saved = { home: process.env.TOKMIZER_HOME, bin: process.env.TOKMIZER_TKR_BIN, network: process.env.TOKMIZER_NETWORK };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-enroll-kick-"));
  process.env.TOKMIZER_HOME = join(home, ".tokmizer");
  const bin = join(home, "tkr.js");
  writeFileSync(bin, "");
  process.env.TOKMIZER_TKR_BIN = bin;
  delete process.env.TOKMIZER_NETWORK;
  spawnMock.mockClear();
});

afterEach(() => {
  for (const [key, value] of [["TOKMIZER_HOME", saved.home], ["TOKMIZER_TKR_BIN", saved.bin], ["TOKMIZER_NETWORK", saved.network]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("background enrollment from a wrapped command", () => {
  it("never registers a device from an empty Tokmizer home", () => {
    kickBackgroundEnroll();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".tokmizer"))).toBe(false);
  });

  it("finishes the sign-up of a home set up by an install step", () => {
    const tk = join(home, ".tokmizer");
    mkdirSync(tk, { recursive: true });
    writeFileSync(join(tk, "network-notice-shown"), String(Date.now()));
    kickBackgroundEnroll();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toContain("heartbeat");
  });

  it("stays offline when the network is off even after setup", () => {
    const tk = join(home, ".tokmizer");
    mkdirSync(tk, { recursive: true });
    writeFileSync(join(tk, "network-notice-shown"), String(Date.now()));
    process.env.TOKMIZER_NETWORK = "0";
    kickBackgroundEnroll();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
