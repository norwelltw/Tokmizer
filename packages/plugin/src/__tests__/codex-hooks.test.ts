import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configBackupFile } from "../config-backup";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCodexHook, codexHooksFile, codexHookInstalled } from "../codex-hooks";

let dir: string;
let orig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-codex-"));
  orig = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (orig === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = orig;
});

const read = () => JSON.parse(readFileSync(codexHooksFile(), "utf8"));

describe("ensureCodexHook", () => {
  it("creates the hooks file with a Bash PreToolUse entry", async () => {
    expect(await ensureCodexHook("/bin/tkr-codex-hook")).toBe("added");
    const pre = read().hooks.PreToolUse;
    expect(pre).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "/bin/tkr-codex-hook", timeout: 10 }] }]);
    expect(codexHookInstalled()).toBe(true);
  });

  it("keeps every existing hook and backs the file up first", async () => {
    const existing = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "orca-hook.sh", timeout: 10 }] }],
        Stop: [{ hooks: [{ type: "command", command: "orca-stop.sh" }] }]
      }
    };
    writeFileSync(codexHooksFile(), JSON.stringify(existing));
    expect(await ensureCodexHook("/bin/tkr-codex-hook")).toBe("added");
    const after = read();
    expect(after.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(after.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(after.hooks.PreToolUse).toHaveLength(2);
    expect(JSON.parse(readFileSync(configBackupFile(codexHooksFile()), "utf8"))).toEqual(existing);
  });

  it("is idempotent and refreshes an outdated command", async () => {
    await ensureCodexHook("/old/tkr-codex-hook");
    expect(await ensureCodexHook("/new/tkr-codex-hook")).toBe("updated");
    expect(await ensureCodexHook("/new/tkr-codex-hook")).toBe("present");
    const pre = read().hooks.PreToolUse;
    expect(pre).toHaveLength(1);
    expect(pre[0].hooks[0].command).toBe("/new/tkr-codex-hook");
  });

  it("refuses to touch an unreadable hooks file", async () => {
    writeFileSync(codexHooksFile(), "{ not json");
    expect(await ensureCodexHook("/bin/tkr-codex-hook")).toBe("error");
    expect(readFileSync(codexHooksFile(), "utf8")).toBe("{ not json");
    expect(existsSync(configBackupFile(codexHooksFile()))).toBe(false);
  });

  it("reports not installed when there is no hooks file", () => {
    expect(codexHookInstalled()).toBe(false);
  });
});

const stableHook = async (mark: string): Promise<string> => {
  const { hookLauncherFile } = await import("../shim/launcher");
  return `[ ! -f '${hookLauncherFile()}' ] || exec /bin/sh '${hookLauncherFile()}' ${mark}`;
};

describe.skipIf(process.platform === "win32")("codexHookCommand", () => {
  it("points the hook at the stable launcher, which records the install", async () => {
    const { codexHookCommand } = await import("../codex-hooks");
    const { readLauncher, hookLauncherFile } = await import("../shim/launcher");
    expect(codexHookCommand("/nonexistent", "/x y/dist/bin/tkr-codex-hook.js")).toBe(await stableHook("tkr-codex-hook"));
    expect(readLauncher(hookLauncherFile())?.target.js).toBe("/x y/dist/bin/tkr-shim.js");
  });

  it("keeps the same command string across installs so Codex never sees a changed hook", async () => {
    const { codexHookCommand } = await import("../codex-hooks");
    expect(codexHookCommand("/a", "/one/dist/bin/tkr-codex-hook.js")).toBe(codexHookCommand("/b", "/two/dist/bin/tkr-codex-hook.js"));
  });
});

describe.skipIf(process.platform === "win32")("removeCodexHook", () => {
  it("removes only the tokmizer hook", async () => {
    const { removeCodexHook, codexHooksFile } = await import("../codex-hooks");
    const { mkdirSync, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
    mkdirSync(join(codexHooksFile(), ".."), { recursive: true });
    wf(codexHooksFile(), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine" }, { type: "command", command: "x tkr-codex-hook" }] }] } }));
    expect(await removeCodexHook()).toBe("removed");
    expect(JSON.parse(rf(codexHooksFile(), "utf8")).hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "mine" }] }]);
    expect(await removeCodexHook()).toBe("absent");
  });
});
