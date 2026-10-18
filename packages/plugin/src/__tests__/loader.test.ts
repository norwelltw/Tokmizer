import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFilters, __resetCache } from "../engine/loader";
import { selectFilter, __resetMatcherCache } from "../engine/matcher";

let origDev: string | undefined;

beforeEach(() => {
  origDev = process.env.TOKMIZER_DEV;
  __resetCache();
});

afterEach(() => {
  if (origDev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = origDev;
  __resetCache();
});

describe("filter loader", () => {
  it("returns empty Map when TOKMIZER_DEV not set (fail-closed)", async () => {
    delete process.env.TOKMIZER_DEV;
    const f = await loadFilters();
    expect(f.size).toBe(0);
  });

  it("loads from disk when TOKMIZER_DEV=1 (dev mode)", async () => {
    process.env.TOKMIZER_DEV = "1";
    const f = await loadFilters();
    expect(f.has("git")).toBe(true);
    expect(f.has("grep")).toBe(true);
    expect(f.has("find")).toBe(true);
    expect(f.has("ps")).toBe(true);
    expect(f.has("ls")).toBe(true);
  });
});

describe("rtk-parity filters match their commands", () => {
  beforeEach(() => {
    process.env.TOKMIZER_DEV = "1";
    __resetMatcherCache();
  });

  async function slugFor(cmd: string): Promise<string | null> {
    const filters = await loadFilters();
    return selectFilter(cmd, filters.values(), null)?.slug ?? null;
  }

  it("routes python invocations to the python filter", async () => {
    expect(await slugFor("python3 scripts/train.py")).toBe("python");
    expect(await slugFor("python3.12 -m pip install rich")).toBe("python");
    expect(await slugFor("bash-tool: python3 scripts/train.py")).toBe("python");
  });

  it("keeps python -m pytest on the pytest filter", async () => {
    expect(await slugFor("python -m pytest tests/")).toBe("pytest");
  });

  it("routes node, black and journalctl", async () => {
    expect(await slugFor("node app.js")).toBe("node");
    expect(await slugFor("black src/")).toBe("black");
    expect(await slugFor("journalctl -u tokmizer -n 200")).toBe("journalctl");
    expect(await slugFor("bash-tool: journalctl -u tokmizer")).toBe("journalctl");
  });

  it("leaves unknown bash-tool commands on the generic squeeze", async () => {
    expect(await slugFor("bash-tool: for s in a b; do osascript x; done")).toBe("bash-tool");
  });
});
