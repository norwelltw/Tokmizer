import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfUpdate, autoUpdateEnabled, setAutoUpdate, claimSelfUpdateSlot, type SelfUpdateDeps } from "../self-update";

let home: string;
let origHome: string | undefined;
let origFlag: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tok-su-"));
  origHome = process.env.TOKMIZER_HOME;
  origFlag = process.env.TOKMIZER_AUTO_UPDATE;
  process.env.TOKMIZER_HOME = home;
  delete process.env.TOKMIZER_AUTO_UPDATE;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  if (origFlag === undefined) delete process.env.TOKMIZER_AUTO_UPDATE;
  else process.env.TOKMIZER_AUTO_UPDATE = origFlag;
});

type Call = { cmd: string; args: string[] };

function deps(over: Partial<SelfUpdateDeps> & { versions?: Record<string, string | undefined> }): { d: SelfUpdateDeps; calls: Call[] } {
  const calls: Call[] = [];
  const versions = { npm: "0.9.33", brew: undefined as string | undefined, ...over.versions };
  const d: SelfUpdateDeps = {
    latest: "0.9.34",
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "npm" && args[0] === "root") return { code: 0, stdout: "/g/lib/node_modules\n" };
      if (cmd === "npm" && args[0] === "i") {
        versions.npm = args[2]!.split("@").pop();
        return { code: 0, stdout: "" };
      }
      if (cmd === "brew" && args[0] === "list") return versions.brew ? { code: 0, stdout: `tokmizer ${versions.brew}\n` } : { code: 1, stdout: "" };
      if (cmd === "brew" && args[0] === "upgrade") {
        versions.brew = "0.9.34";
        return { code: 0, stdout: "" };
      }
      return { code: 0, stdout: "" };
    },
    npmVersion: () => versions.npm,
    writable: () => true,
    codexInstalled: () => false,
    ensureCodexHook: async () => "added",
    ...over
  };
  return { d, calls };
}

describe("selfUpdate", () => {
  it("upgrades an older npm global install to the signed version, then refreshes shims", async () => {
    const { d, calls } = deps({});
    const actions = await selfUpdate(d);
    expect(calls).toContainEqual({ cmd: "npm", args: ["i", "-g", "@tokmizer/plugin@0.9.34", "--no-audit", "--no-fund"] });
    expect(calls).toContainEqual({ cmd: "tkr", args: ["shims-refresh"] });
    expect(actions).toContain("npm 0.9.33 -> 0.9.34");
  });

  it("does nothing when the install is current or newer", async () => {
    for (const v of ["0.9.34", "0.9.40"]) {
      const { d, calls } = deps({ versions: { npm: v } });
      await selfUpdate(d);
      expect(calls.some((c) => c.args[0] === "i")).toBe(false);
    }
  });

  it("never installs a version that is not a plain semver", async () => {
    for (const latest of [undefined, "latest", "0.9.34 && rm -rf /", "1.0.0-beta.1"]) {
      const { d, calls } = deps({ latest });
      await selfUpdate(d);
      expect(calls.some((c) => c.args[0] === "i" || c.args[0] === "upgrade")).toBe(false);
    }
  });

  it("leaves a global prefix it cannot write to alone", async () => {
    const { d, calls } = deps({ writable: () => false });
    const actions = await selfUpdate(d);
    expect(calls.some((c) => c.args[0] === "i")).toBe(false);
    expect(actions).toContain("npm needs permission");
  });

  it("upgrades an older Homebrew install without cleaning the previous keg", async () => {
    const { d, calls } = deps({ versions: { npm: undefined, brew: "0.9.33" } });
    const actions = await selfUpdate(d);
    expect(calls).toContainEqual({ cmd: "brew", args: ["upgrade", "tokmizer"] });
    expect(actions).toContain("brew 0.9.33 -> 0.9.34");
  });

  it("adds the Codex hook once when Codex is installed and the CLI is current", async () => {
    let added = 0;
    const { d } = deps({ codexInstalled: () => true, ensureCodexHook: async () => { added += 1; return "added"; } });
    await selfUpdate(d);
    await selfUpdate(d);
    expect(added).toBe(1);
    expect(existsSync(join(home, "codex-hook-offered"))).toBe(true);
  });

  it("does not add the Codex hook while the only CLI is too old to answer it", async () => {
    let added = 0;
    const { d } = deps({ writable: () => false, codexInstalled: () => true, ensureCodexHook: async () => { added += 1; return "added"; } });
    await selfUpdate(d);
    expect(added).toBe(0);
  });

  it("is fully disabled by tkr auto-update off or TOKMIZER_AUTO_UPDATE=0", async () => {
    setAutoUpdate(false);
    expect(autoUpdateEnabled()).toBe(false);
    const { d, calls } = deps({});
    expect(await selfUpdate(d)).toEqual(["disabled"]);
    expect(calls).toHaveLength(0);
    setAutoUpdate(true);
    expect(autoUpdateEnabled()).toBe(true);
    process.env.TOKMIZER_AUTO_UPDATE = "0";
    expect(autoUpdateEnabled()).toBe(false);
  });
});

describe("claimSelfUpdateSlot", () => {
  it("allows one run per cooldown window", () => {
    expect(claimSelfUpdateSlot(1_000_000)).toBe(true);
    expect(claimSelfUpdateSlot(1_000_000 + 60_000)).toBe(false);
    expect(claimSelfUpdateSlot(1_000_000 + 7 * 3600_000)).toBe(true);
  });

  it("works when the home directory does not exist yet", () => {
    rmSync(home, { recursive: true, force: true });
    expect(claimSelfUpdateSlot(5)).toBe(true);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "x"), "");
  });
});

describe("selfUpdate and Homebrew trust", () => {
  it("names the command to run when Homebrew refuses an untrusted tap", async () => {
    const { d } = deps({
      versions: { npm: undefined, brew: "0.9.31" },
      run: async (cmd, args) => {
        if (cmd === "npm") return { code: 1, stdout: "" };
        if (args[0] === "list") return { code: 0, stdout: "tokmizer 0.9.31\n" };
        if (args[0] === "upgrade") return { code: 1, stdout: "", stderr: "Error: Refusing to load formula from untrusted tap norwelltw/tokmizer." };
        return { code: 0, stdout: "" };
      }
    });
    expect(await selfUpdate(d)).toContain("brew tap not trusted: run brew trust norwelltw/tokmizer");
  });
});
