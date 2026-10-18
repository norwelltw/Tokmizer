import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHost, detectHostFromArgv, adapterFor, hasNativeHook, hostOutputCapBytes, nativeHookSetupCommand } from "../host-detect";
import { ensureCursorHook } from "../cursor-hooks";
import { ensureGeminiHook } from "../gemini-hooks";
import { JSON_HOOK_AGENTS, jsonHookAgent } from "../agent-hooks";

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-host-detect-"));
  for (const key of ["HOME", "USERPROFILE", "GEMINI_CLI_HOME", "COPILOT_HOME", "QWEN_HOME", "XDG_CONFIG_HOME"]) {
    saved[key] = process.env[key];
    process.env[key] = home;
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("detectHost", () => {
  it("falls back to shell when no env match", () => {
    const r = detectHost({});
    expect(r.host).toBe("shell");
    expect(r.source).toBe("fallback");
    expect(r.shimRecommended).toBe(true);
  });

  it("detects claude-code via CLAUDE_CODE", () => {
    const r = detectHost({ CLAUDE_CODE: "1" });
    expect(r.host).toBe("claude-code");
    expect(r.shimRecommended).toBe(false);
  });

  it("detects claude-code via real-world CLAUDECODE env", () => {
    const r = detectHost({ CLAUDECODE: "1" });
    expect(r.host).toBe("claude-code");
    expect(hostOutputCapBytes(r.host)).toBeNull();
  });

  it("detects claude-code via CLAUDE_CODE_ENTRYPOINT", () => {
    const r = detectHost({ CLAUDE_CODE_ENTRYPOINT: "cli" });
    expect(r.host).toBe("claude-code");
  });

  it("detects codex via CODEX_VERSION", () => {
    const r = detectHost({ CODEX_VERSION: "1.2.3" });
    expect(r.host).toBe("codex");
    expect(r.shimRecommended).toBe(false);
  });

  it("detects cursor via CURSOR_TRACE_ID", () => {
    const r = detectHost({ CURSOR_TRACE_ID: "abc" });
    expect(r.host).toBe("cursor");
    expect(r.shimRecommended).toBe(true);
  });

  it("detects aider via AIDER_VERSION", () => {
    const r = detectHost({ AIDER_VERSION: "0.50.0" });
    expect(r.host).toBe("aider");
    expect(r.shimRecommended).toBe(true);
  });

  it("detects gemini-cli", () => {
    expect(detectHost({ GEMINI_CLI_VERSION: "1" }).host).toBe("gemini-cli");
  });

  it("detects windsurf", () => {
    expect(detectHost({ WINDSURF_VERSION: "1" }).host).toBe("windsurf");
  });

  it("detects cline", () => {
    expect(detectHost({ CLINE_VERSION: "1" }).host).toBe("cline");
  });

  it("detects copilot", () => {
    expect(detectHost({ GITHUB_COPILOT_VERSION: "1" }).host).toBe("copilot");
  });

  it("detects cursor via CURSOR_AGENT set in Cursor agent shells", () => {
    expect(detectHost({ CURSOR_AGENT: "1" }).host).toBe("cursor");
  });

  it("detects gemini-cli via the GEMINI_CLI variable set by run_shell_command", () => {
    expect(detectHost({ GEMINI_CLI: "1" }).host).toBe("gemini-cli");
  });

  it("honours an explicit TOKMIZER_HOST over other probes", () => {
    const r = detectHost({ TOKMIZER_HOST: "cursor", CLAUDECODE: "1" });
    expect(r.host).toBe("cursor");
    expect(r.source).toBe("env");
    expect(detectHost({ TOKMIZER_HOST: "gemini-cli" }).host).toBe("gemini-cli");
  });

  it("ignores an unknown TOKMIZER_HOST value", () => {
    expect(detectHost({ TOKMIZER_HOST: "evil", CODEX_VERSION: "1" }).host).toBe("codex");
    expect(detectHost({ TOKMIZER_HOST: "evil" }).host).toBe("shell");
  });

  it("claude-code wins over cursor when both set", () => {
    const r = detectHost({ CLAUDE_CODE: "1", CURSOR_VERSION: "x" });
    expect(r.host).toBe("claude-code");
  });
});

describe("detectHostFromArgv", () => {
  it("parses --host claude-code", () => {
    expect(detectHostFromArgv(["--host", "claude-code"])).toBe("claude-code");
  });

  it("returns null when not present", () => {
    expect(detectHostFromArgv([])).toBeNull();
  });

  it("rejects unknown host", () => {
    expect(detectHostFromArgv(["--host", "evil"])).toBeNull();
  });
});

describe("adapterFor", () => {
  it("claude-code → native-hooks", () => {
    expect(adapterFor("claude-code")).toBe("native-hooks");
  });
  it("codex → native-hooks", () => {
    expect(adapterFor("codex")).toBe("native-hooks");
  });
  it("cursor → shell-shim", () => {
    expect(adapterFor("cursor")).toBe("shell-shim");
  });
  it("shell → shell-shim", () => {
    expect(adapterFor("shell")).toBe("shell-shim");
  });
});

describe("optional native hooks", () => {
  it("keeps Cursor and Gemini CLI on the shell-shim until their hook is installed", () => {
    for (const host of ["cursor", "gemini-cli"] as const) {
      expect(hasNativeHook(host)).toBe(false);
      expect(adapterFor(host)).toBe("shell-shim");
    }
    expect(detectHost({ CURSOR_AGENT: "1" }).shimRecommended).toBe(true);
    expect(detectHost({ GEMINI_CLI: "1" }).shimRecommended).toBe(true);
    expect(nativeHookSetupCommand("cursor")).toBe("tkr setup-cursor");
    expect(nativeHookSetupCommand("gemini-cli")).toBe("tkr setup-gemini");
  });

  it("reports Cursor as a native-hook host once tkr setup-cursor ran", async () => {
    expect(await ensureCursorHook("/bin/tkr-cursor-hook")).toBe("added");
    expect(hasNativeHook("cursor")).toBe(true);
    expect(adapterFor("cursor")).toBe("native-hooks");
    expect(detectHost({ CURSOR_AGENT: "1" }).shimRecommended).toBe(false);
    expect(detectHost({ TOKMIZER_HOST: "cursor" }).shimRecommended).toBe(false);
    expect(nativeHookSetupCommand("cursor")).toBeNull();
    expect(hasNativeHook("gemini-cli")).toBe(false);
  });

  it("reports Gemini CLI as a native-hook host once tkr setup-gemini ran", async () => {
    expect(await ensureGeminiHook("/bin/tkr-gemini-hook")).toBe("added");
    expect(hasNativeHook("gemini-cli")).toBe(true);
    expect(adapterFor("gemini-cli")).toBe("native-hooks");
    expect(detectHost({ GEMINI_CLI: "1" }).shimRecommended).toBe(false);
    expect(nativeHookSetupCommand("gemini-cli")).toBeNull();
    expect(hasNativeHook("cursor")).toBe(false);
  });

  it("detects the JSON-hook agents from their env markers or TOKMIZER_HOST", () => {
    expect(detectHost({ QWEN_CODE: "1" }).host).toBe("qwen-code");
    expect(detectHost({ QWEN_CODE: "1", GEMINI_API_KEY: "k" }).host).toBe("qwen-code");
    expect(detectHost({ CRUSH: "1" }).host).toBe("crush");
    for (const host of ["copilot", "droid", "trae", "qwen-code", "crush", "junie"] as const) {
      expect(detectHost({ TOKMIZER_HOST: host })).toMatchObject({ host, source: "env" });
      expect(detectHostFromArgv(["--host", host])).toBe(host);
    }
  });

  it.each(JSON_HOOK_AGENTS.map((a) => a.id))("reports %s as a native-hook host only once its hook is installed", async (id) => {
    const agent = jsonHookAgent(id);
    expect(hasNativeHook(id)).toBe(false);
    expect(adapterFor(id)).toBe("shell-shim");
    expect(detectHost({ TOKMIZER_HOST: id }).shimRecommended).toBe(true);
    expect(nativeHookSetupCommand(id)).toBe(agent.setup);
    expect(await agent.ensure(`/bin/${agent.bin}`)).toBe("added");
    expect(hasNativeHook(id)).toBe(true);
    expect(adapterFor(id)).toBe("native-hooks");
    expect(detectHost({ TOKMIZER_HOST: id }).shimRecommended).toBe(false);
    expect(nativeHookSetupCommand(id)).toBeNull();
    expect(hasNativeHook("cursor")).toBe(false);
  });

  it("never suggests a setup command for hosts that are always or never native", () => {
    for (const host of ["claude-code", "codex", "aider", "shell"] as const) {
      expect(nativeHookSetupCommand(host)).toBeNull();
    }
  });
});

describe("hostOutputCapBytes", () => {
  it("does not cap any host so savings reflect full raw output", () => {
    expect(hostOutputCapBytes("claude-code")).toBeNull();
    expect(hostOutputCapBytes("codex")).toBeNull();
    expect(hostOutputCapBytes("shell")).toBeNull();
    expect(hostOutputCapBytes("cursor")).toBeNull();
    expect(hostOutputCapBytes("gemini-cli")).toBeNull();
  });
});
