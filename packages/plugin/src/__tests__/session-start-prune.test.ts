import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const hookPath = join(here, "..", "..", "hooks", "on-session-start.mjs");

let base: string;
let home: string;

function runHook(pluginRoot: string): void {
  execFileSync(process.execPath, [hookPath], {
    env: {
      ...process.env,
      TOKMIZER_HOME: home,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "claude-commands")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function addVersionDir(name: string, ageDays: number): string {
  const p = join(base, name);
  mkdirSync(p, { recursive: true });
  const t = new Date(Date.now() - ageDays * 24 * 3600_000);
  utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "tkr-prune-cache-"));
  home = mkdtempSync(join(tmpdir(), "tkr-prune-home-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("session-start prunes stale cached plugin versions", () => {
  it("removes old version dirs, keeps itself and the newest other version", () => {
    addVersionDir("0.7.2", 30);
    addVersionDir("0.9.9", 30);
    addVersionDir("0.9.10", 30);
    const self = addVersionDir("0.9.31", 0);

    runHook(self);

    expect(existsSync(join(base, "0.9.31"))).toBe(true);
    expect(existsSync(join(base, "0.9.10"))).toBe(true);
    expect(existsSync(join(base, "0.7.2"))).toBe(false);
    expect(existsSync(join(base, "0.9.9"))).toBe(false);
  });

  it("keeps versions younger than seven days", () => {
    addVersionDir("0.9.29", 1);
    addVersionDir("0.9.30", 2);
    const self = addVersionDir("0.9.31", 0);

    runHook(self);

    expect(existsSync(join(base, "0.9.29"))).toBe(true);
    expect(existsSync(join(base, "0.9.30"))).toBe(true);
  });

  it("does nothing when the plugin does not run from a semver cache dir", () => {
    addVersionDir("0.7.2", 30);
    const self = join(base, "dev-checkout");
    mkdirSync(self, { recursive: true });

    runHook(self);

    expect(existsSync(join(base, "0.7.2"))).toBe(true);
  });
});
