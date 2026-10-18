import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installCommand, pruneCommands, commandsInstallStatus } from "../cache";

const prev = process.env.TOKMIZER_CLAUDE_COMMANDS_DIR;
const prevHome = process.env.TOKMIZER_HOME;
const MANAGED = "---\ndescription: x\nmanaged-by: tokmizer\n---\nbody";
let dir: string;

function commandsDir(): string {
  return join(dir, "commands");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-cmd-"));
  process.env.TOKMIZER_CLAUDE_COMMANDS_DIR = commandsDir();
  process.env.TOKMIZER_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.TOKMIZER_CLAUDE_COMMANDS_DIR;
  else process.env.TOKMIZER_CLAUDE_COMMANDS_DIR = prev;
  if (prevHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = prevHome;
});

describe("managed command cache", () => {
  it("installCommand writes the command file", async () => {
    await installCommand("power", MANAGED);
    expect(readFileSync(join(commandsDir(), "power.md"), "utf8")).toBe(MANAGED);
  });

  it("pruneCommands removes managed files not in keep list", async () => {
    await installCommand("power", MANAGED);
    await pruneCommands([]);
    expect(existsSync(join(commandsDir(), "power.md"))).toBe(false);
  });

  it("pruneCommands keeps names in keep list", async () => {
    await installCommand("power", MANAGED);
    await pruneCommands(["power"]);
    expect(existsSync(join(commandsDir(), "power.md"))).toBe(true);
  });

  it("pruneCommands never touches files without the managed marker", async () => {
    mkdirSync(commandsDir(), { recursive: true });
    writeFileSync(join(commandsDir(), "mine.md"), "my own command");
    await pruneCommands([]);
    expect(existsSync(join(commandsDir(), "mine.md"))).toBe(true);
  });

  it("pruneCommands is a no-op when the directory does not exist", async () => {
    await expect(pruneCommands([])).resolves.toBeUndefined();
  });

  it("pruneCommands leaves a user copy of a managed command untouched", async () => {
    mkdirSync(commandsDir(), { recursive: true });
    writeFileSync(join(commandsDir(), "my-gain.md"), "body gain\n<!-- managed-by: tokmizer -->\n");
    await pruneCommands([]);
    expect(existsSync(join(commandsDir(), "my-gain.md"))).toBe(true);
  });

  it("pruneCommands removes legacy server commands from installs that predate the registry", async () => {
    mkdirSync(commandsDir(), { recursive: true });
    writeFileSync(join(commandsDir(), "tkr-reducer.md"), MANAGED);
    await pruneCommands([]);
    expect(existsSync(join(commandsDir(), "tkr-reducer.md"))).toBe(false);
  });

  it("installCommand refuses to overwrite a user file without the managed marker", async () => {
    mkdirSync(commandsDir(), { recursive: true });
    writeFileSync(join(commandsDir(), "power.md"), "my own power command\n");
    await installCommand("power", MANAGED);
    expect(readFileSync(join(commandsDir(), "power.md"), "utf8")).toBe("my own power command\n");
  });

  it("installCommand refreshes its own managed file", async () => {
    await installCommand("power", MANAGED);
    const v2 = MANAGED.replace("body", "body v2");
    await installCommand("power", v2);
    expect(readFileSync(join(commandsDir(), "power.md"), "utf8")).toBe(v2);
  });

  it("commandsInstallStatus counts installed static copies", async () => {
    mkdirSync(commandsDir(), { recursive: true });
    writeFileSync(join(commandsDir(), "tkr.md"), "x");
    writeFileSync(join(commandsDir(), "tkr-gain.md"), "x");
    const s = await commandsInstallStatus();
    expect(s.total).toBe(9);
    expect(s.installed).toBe(2);
  });

  it("commandsInstallStatus reports zero when the directory is missing", async () => {
    const s = await commandsInstallStatus();
    expect(s.installed).toBe(0);
    expect(s.total).toBe(9);
  });
});
