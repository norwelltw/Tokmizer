import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const hookPath = join(here, "..", "..", "hooks", "on-session-start.mjs");
const realCommandsDir = join(here, "..", "..", "command-templates");

let home: string;
let pluginRoot: string;
let commandsDir: string;

function runHook(env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [hookPath], {
    env: {
      ...process.env,
      TOKMIZER_HOME: home,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      TOKMIZER_CLAUDE_COMMANDS_DIR: commandsDir,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  }).toString("utf8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-sscmd-home-"));
  pluginRoot = mkdtempSync(join(tmpdir(), "tkr-sscmd-root-"));
  commandsDir = join(home, "claude-commands");
  mkdirSync(join(pluginRoot, "command-templates"), { recursive: true });
  writeFileSync(join(pluginRoot, "command-templates", "tkr-gain.md"), "---\ndescription: gain\n---\nbody gain\n");
  writeFileSync(join(pluginRoot, "command-templates", "tkr.md"), "---\ndescription: tkr\n---\nbody tkr\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(pluginRoot, { recursive: true, force: true });
});

describe("session-start installs unprefixed command copies", () => {
  it("copies plugin commands into the user commands dir with the managed marker", () => {
    runHook();
    const names = readdirSync(commandsDir).sort();
    expect(names).toEqual(["tkr-gain.md", "tkr.md"]);
    const body = readFileSync(join(commandsDir, "tkr-gain.md"), "utf8");
    expect(body).toContain("managed-by: tokmizer");
    expect(body).toContain("body gain");
  });

  it("never overwrites a user file that lacks the managed marker", () => {
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, "tkr-gain.md"), "my own custom command\n");
    runHook();
    expect(readFileSync(join(commandsDir, "tkr-gain.md"), "utf8")).toBe("my own custom command\n");
  });

  it("is idempotent and refreshes managed copies when the source changes", () => {
    runHook();
    writeFileSync(join(pluginRoot, "command-templates", "tkr-gain.md"), "---\ndescription: gain\n---\nbody v2\n");
    runHook();
    expect(readFileSync(join(commandsDir, "tkr-gain.md"), "utf8")).toContain("body v2");
  });

  it("leaves only .md files behind, no temp residue", () => {
    runHook();
    runHook();
    const names = readdirSync(commandsDir);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.endsWith(".md"))).toBe(true);
  });
});

describe("no shell profile nudge", () => {
  it("never asks the user to route every terminal through Tokmizer", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "onboarded"), String(Date.now() - 25 * 3600 * 1000));
    const bin = join(home, "fakebin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tkr"), "#!/bin/sh\n");
    for (const path of [bin, join(home, "no-such-dir")]) {
      const out = runHook({ PATH: path });
      expect(out).not.toContain("tkr shim install");
      expect(out).not.toContain("install.sh");
    }
  });
});

describe("static command names are pruned-safe", () => {
  it("every shipped command name is in the STATIC_COMMAND_NAMES keep list", async () => {
    const { STATIC_COMMAND_NAMES } = await import("../cache");
    const shipped = readdirSync(realCommandsDir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3));
    for (const name of shipped) {
      expect(STATIC_COMMAND_NAMES, name).toContain(name);
    }
  });

  it("every shipped template carries the uninstall cleanup hint", () => {
    const shipped = readdirSync(realCommandsDir).filter((n) => n.endsWith(".md"));
    expect(shipped.length).toBeGreaterThan(0);
    for (const f of shipped) {
      expect(readFileSync(join(realCommandsDir, f), "utf8"), f).toContain("was uninstalled");
    }
  });

  it("pruneCommands keeps managed static copies not in the server list", async () => {
    process.env.TOKMIZER_CLAUDE_COMMANDS_DIR = commandsDir;
    const prevHome = process.env.TOKMIZER_HOME;
    process.env.TOKMIZER_HOME = home;
    try {
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(join(commandsDir, "tkr-gain.md"), "x\nmanaged-by: tokmizer\n");
      writeFileSync(join(commandsDir, "tkr-reducer.md"), "x\nmanaged-by: tokmizer\n");
      writeFileSync(join(commandsDir, "my-copy.md"), "x\nmanaged-by: tokmizer\n");
      const { pruneCommands } = await import("../cache");
      await pruneCommands([]);
      const names = readdirSync(commandsDir).sort();
      expect(names).toContain("tkr-gain.md");
      expect(names).toContain("my-copy.md");
      expect(names).not.toContain("tkr-reducer.md");
    } finally {
      delete process.env.TOKMIZER_CLAUDE_COMMANDS_DIR;
      if (prevHome === undefined) delete process.env.TOKMIZER_HOME;
      else process.env.TOKMIZER_HOME = prevHome;
    }
  });
});
