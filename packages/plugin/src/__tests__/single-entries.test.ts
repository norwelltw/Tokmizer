import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryWords, selectEntry } from "../single-entries";
import { selfInvocation, singleBinary, stableSelfPath } from "../self-command";
import { isEntryModule, selectSingleEntry } from "../entry";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("single binary entry selection", () => {
  it("routes internal subcommands and hooks to their entries with the remaining arguments", () => {
    expect(selectEntry(["processor"])).toEqual({ entry: "tkr-processor", args: [] });
    expect(selectEntry(["daemon"])).toEqual({ entry: "tkr-daemon", args: [] });
    expect(selectEntry(["exec", "git", "status"])).toEqual({ entry: "tkr-exec", args: ["git", "status"] });
    expect(selectEntry(["shim-run", "--as", "git", "log"])).toEqual({ entry: "tkr-shim", args: ["--as", "git", "log"] });
    expect(selectEntry(["hook", "agent", "vibe"])).toEqual({ entry: "tkr-agent-hook", args: ["vibe"] });
    expect(selectEntry(["hook", "pre-tool-use"])).toEqual({ entry: "pre-tool-use", args: [] });
    expect(selectEntry(["hook", "session-start"])).toEqual({ entry: "on-session-start", args: [] });
    expect(selectEntry(["hook", "reducer-stop"])).toEqual({ entry: "reducer-stop", args: [] });
  });

  it("leaves every user command, including look-alikes, to the CLI", () => {
    for (const args of [[], ["gain", "--day"], ["shim", "install"], ["hook"], ["hook", "unknown"], ["hook", "toString"], ["constructor"], ["--version"]]) {
      expect(selectEntry(args)).toEqual({ entry: "tkr", args });
    }
  });

  it("maps every script entry back to the words that select it", () => {
    const scripts = ["tkr.js", "tkr-exec.js", "tkr-processor.js", "tkr-daemon.js", "tkr-shim.js", "tkr-codex-hook.js", "tkr-cursor-hook.js", "tkr-gemini-hook.js",
      "tkr-agent-hook.js", "tkr-copilot-hook.js", "tkr-droid-hook.js", "tkr-trae-hook.js", "tkr-qwen-hook.js", "tkr-crush-hook.js", "tkr-junie-hook.js",
      "pre-tool-use.js", "post-tool-use.js", "session-recap.js", "on-session-start.mjs", "reducer-session-start.js", "reducer-prompt-submit.js", "reducer-stop.js"];
    for (const script of scripts) {
      const words = entryWords(`/pkg/dist/bin/${script}`);
      expect(words, script).not.toBeNull();
      expect(selectEntry([...words!, "x"]).entry).toBe(script.replace(/\.m?js$/, ""));
    }
    expect(entryWords("/pkg/dist/bin/unknown.js")).toBeNull();
  });
});

describe("self invocation", () => {
  it("keeps the Node script form outside the single binary", () => {
    expect(singleBinary()).toBe(false);
    expect(selfInvocation("/pkg/dist/bin/tkr-daemon.js", "/usr/bin/node")).toEqual(["/usr/bin/node", "/pkg/dist/bin/tkr-daemon.js"]);
  });

  it("re-enters the running executable inside the single binary", () => {
    vi.stubEnv("TOKMIZER_SINGLE_BINARY", "1");
    expect(selfInvocation("/pkg/dist/bin/tkr-daemon.js")).toEqual([process.execPath, "daemon"]);
    expect(selfInvocation("/pkg/dist/bin/tkr.js")).toEqual([process.execPath]);
    expect(selfInvocation("/custom/runner.js", "/usr/bin/node")).toEqual(["/usr/bin/node", "/custom/runner.js"]);
  });

  it.skipIf(process.platform === "win32")("prefers a PATH link that resolves to the running executable", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tkr-self-")));
    try {
      const real = join(dir, "real-tkr");
      writeFileSync(real, "");
      const bin = join(dir, "bin");
      const npmBin = join(dir, "node_modules", ".bin");
      mkdirSync(bin);
      mkdirSync(npmBin, { recursive: true });
      symlinkSync(real, join(bin, "tkr"));
      symlinkSync(real, join(npmBin, "tkr"));
      expect(stableSelfPath(`/nonexistent:${npmBin}:${bin}`, "darwin", real)).toBe(join(bin, "tkr"));
      expect(stableSelfPath(`/nonexistent:${npmBin}`, "darwin", real)).toBe(real);
      writeFileSync(join(dir, "other"), "");
      expect(stableSelfPath(bin, "darwin", join(dir, "other"))).toBe(join(dir, "other"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat imported modules as entries once the single binary selected another entry", () => {
    const url = "file:///pkg/dist/hooks-host/pre-tool-use.js";
    expect(isEntryModule("/pkg/dist/hooks-host/pre-tool-use.js", url, "pre-tool-use")).toBe(true);
    expect(isEntryModule("", url, "pre-tool-use")).toBe(false);
    selectSingleEntry("tkr");
    expect(isEntryModule("/pkg/dist/hooks-host/pre-tool-use.js", url, "pre-tool-use")).toBe(false);
    selectSingleEntry("pre-tool-use");
    expect(isEntryModule("tkr-main", url, "pre-tool-use")).toBe(true);
    expect(isEntryModule("tkr-main", url, "post-tool-use")).toBe(false);
  });
});
