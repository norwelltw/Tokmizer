import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configBackupFile } from "../config-backup";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorHookCommand, cursorHookInstalled, cursorHooksFile, ensureCursorHook, removeCursorHook } from "../cursor-hooks";

let dir: string;
let origHome: string | undefined;
let origProfile: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-cursor-"));
  origHome = process.env.HOME;
  origProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origProfile;
});

const read = () => JSON.parse(readFileSync(cursorHooksFile(), "utf8"));

describe("ensureCursorHook", () => {
  it("creates ~/.cursor/hooks.json with version 1 and a Shell preToolUse entry", async () => {
    expect(cursorHooksFile()).toBe(join(dir, ".cursor", "hooks.json"));
    expect(await ensureCursorHook("/bin/tkr-cursor-hook")).toBe("added");
    expect(read()).toEqual({ version: 1, hooks: { preToolUse: [{ command: "/bin/tkr-cursor-hook", matcher: "Shell", timeout: 10 }] } });
    expect(cursorHookInstalled()).toBe(true);
  });

  it("keeps every existing hook and setting and backs the file up first", async () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [{ command: "./hooks/validate.sh", matcher: "Shell|Read" }],
        afterFileEdit: [{ command: "./hooks/format.sh" }]
      },
      custom: true
    };
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(cursorHooksFile(), JSON.stringify(existing));
    expect(await ensureCursorHook("/bin/tkr-cursor-hook")).toBe("added");
    const after = read();
    expect(after.custom).toBe(true);
    expect(after.hooks.afterFileEdit).toEqual(existing.hooks.afterFileEdit);
    expect(after.hooks.preToolUse[0]).toEqual(existing.hooks.preToolUse[0]);
    expect(after.hooks.preToolUse).toHaveLength(2);
    expect(JSON.parse(readFileSync(configBackupFile(cursorHooksFile()), "utf8"))).toEqual(existing);
  });

  it("is idempotent and refreshes an outdated command", async () => {
    await ensureCursorHook("/old/tkr-cursor-hook");
    expect(await ensureCursorHook("/new/tkr-cursor-hook")).toBe("updated");
    expect(await ensureCursorHook("/new/tkr-cursor-hook")).toBe("present");
    const pre = read().hooks.preToolUse;
    expect(pre).toHaveLength(1);
    expect(pre[0].command).toBe("/new/tkr-cursor-hook");
  });

  it("refuses to touch a hooks file that is not valid JSON", async () => {
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(cursorHooksFile(), "{ not json");
    expect(await ensureCursorHook("/bin/tkr-cursor-hook")).toBe("error");
    expect(readFileSync(cursorHooksFile(), "utf8")).toBe("{ not json");
    expect(existsSync(configBackupFile(cursorHooksFile()))).toBe(false);
    expect(cursorHookInstalled()).toBe(false);
  });
});

describe("removeCursorHook", () => {
  it("removes only the tokmizer entry and keeps the rest", async () => {
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(cursorHooksFile(), JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: "./hooks/validate.sh", matcher: "Shell" }] } }));
    await ensureCursorHook("/bin/tkr-cursor-hook");
    expect(await removeCursorHook()).toBe("removed");
    expect(read().hooks.preToolUse).toEqual([{ command: "./hooks/validate.sh", matcher: "Shell" }]);
    expect(cursorHookInstalled()).toBe(false);
    expect(await removeCursorHook()).toBe("absent");
  });

  it("drops the empty preToolUse list when the hook was the only one", async () => {
    await ensureCursorHook("/bin/tkr-cursor-hook");
    expect(await removeCursorHook()).toBe("removed");
    expect(read()).toEqual({ version: 1, hooks: {} });
  });

  it("reports absent when there is no file and error when it is unreadable", async () => {
    expect(await removeCursorHook()).toBe("absent");
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(cursorHooksFile(), "{ not json");
    expect(await removeCursorHook()).toBe("error");
    expect(readFileSync(cursorHooksFile(), "utf8")).toBe("{ not json");
  });
});

const stableHook = async (mark: string): Promise<string> => {
  const { hookLauncherFile } = await import("../shim/launcher");
  return `[ ! -f '${hookLauncherFile()}' ] || exec /bin/sh '${hookLauncherFile()}' ${mark}`;
};

describe.skipIf(process.platform === "win32")("cursorHookCommand", () => {
  it("points the hook at the stable launcher", async () => {
    expect(cursorHookCommand("/nonexistent", "/x y/tkr-cursor-hook.js")).toBe(await stableHook("tkr-cursor-hook"));
  });
});
